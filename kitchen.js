const STATUSES = new Set(["READY","OUT_FOR_DELIVERY"]);
const COOKIE = "hf_kitchen_session";
const enc = new TextEncoder();

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers: {"Content-Type":"application/json","Cache-Control":"no-store"}});
}
function escapeHtml(value) {
  return String(value||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
async function sendRefundEmail(env,order,amountPence) {
  if(!env.RESEND_API_KEY) return "not_configured";
  if(!order.customer_email) return "no_customer_email";
  const key="customer-refund/"+order.id;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS order_email_sends (idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await env.DB.prepare("INSERT OR IGNORE INTO order_email_sends (idempotency_key,status) VALUES (?, 'pending')").bind(key).run();
  const claim=await env.DB.prepare("UPDATE order_email_sends SET status='processing',updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=? AND (status IN ('pending','failed') OR (status='processing' AND updated_at < datetime('now','-10 minutes')))").bind(key).run();
  if(!claim.meta?.changes) return "already_sent_or_processing";
  const amount="£"+(Number(amountPence||0)/100).toFixed(2);
  const name=String(order.customer_name||"there");
  const reference=String(order.order_reference||order.id);
  const text="Hi "+name+",\n\nYour Hungry Fox order "+reference+" has been cancelled and a full refund of "+amount+" has been issued to your original payment method. Your bank or card provider may take a few working days to show the refund.\n\nThank you,\nThe Hungry Fox";
  const html="<div style='font-family:Arial,sans-serif;color:#242424;max-width:600px;margin:auto'><div style='background:#f7f0e5;padding:18px 24px;text-align:center'><h1 style='color:#211b18;font-size:24px;margin:0'>THE HUNGRY FOX</h1></div><div style='padding:24px'><h2 style='color:#d87518'>Your refund has been issued</h2><p>Hi "+escapeHtml(name)+",</p><p>Your Hungry Fox order has been cancelled and a full refund has been issued to your original payment method.</p><p><strong>Order reference:</strong> "+escapeHtml(reference)+"<br><strong>Refund amount:</strong> "+amount+"</p><p>Your bank or card provider may take a few working days to show the refund.</p><p>Thank you,<br>The Hungry Fox</p></div></div>";
  try {
    const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify({from:"The Hungry Fox <orders@thehungryfox.co.uk>",to:[order.customer_email],subject:"Your Hungry Fox refund — "+reference,text,html})});
    if(!response.ok) throw new Error("Resend refund email failed ("+response.status+"): "+await response.text());
    await env.DB.prepare("UPDATE order_email_sends SET status='sent',updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=?").bind(key).run();
    return "sent";
  } catch(error) {
    await env.DB.prepare("UPDATE order_email_sends SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=?").bind(key).run();
    return "failed";
  }
}
function safeEqual(a,b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let n=0; for(let i=0;i<a.length;i++) n |= a.charCodeAt(i)^b.charCodeAt(i);
  return n===0;
}
async function signature(value, secret) {
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,enc.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
async function makeCookie(secret) {
  const expires=Math.floor(Date.now()/1000)+60*60*12;
  const payload=String(expires);
  return payload+"."+await signature(payload,secret);
}
async function authorised(req, env) {
  const raw=req.headers.get("Cookie")||"";
  const match=raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="));
  if(!match||!env.DASHBOARD_PASSWORD) return false;
  const token=decodeURIComponent(match.slice(COOKIE.length+1));
  const [expires,sig,...rest]=token.split(".");
  if(rest.length||!/^\d+$/.test(expires)||Number(expires)<Date.now()/1000) return false;
  return safeEqual(sig,await signature(expires,env.DASHBOARD_PASSWORD));
}
function cookieHeader(value, maxAge) {
  return COOKIE+"="+encodeURIComponent(value)+"; Path=/kitchen; HttpOnly; Secure; SameSite=Strict; Max-Age="+maxAge;
}
export async function savePaidOrder(session, lineItems, env) {
  if(!env.DB) throw new Error("D1 database binding DB is missing");
  const m=session.metadata||{};
  const reference=session.id.slice(-8).toUpperCase();
  const deliveryPrefix="Delivery and minimum-order adjustment";
  const lines=(lineItems||[]).map(x=>({
    name:String(x.description||"Hungry Fox item"),
    quantity:Number(x.quantity||1),
    amount:Number(x.amount_total||0)
  }));
  const delivery=lines.filter(x=>x.name.startsWith(deliveryPrefix)).reduce((n,x)=>n+x.amount,0);
  const subtotal=lines.filter(x=>!x.name.startsWith(deliveryPrefix)).reduce((n,x)=>n+x.amount,0);
  const total=Number(session.amount_total??(subtotal+delivery));
  await env.DB.prepare(`INSERT OR IGNORE INTO orders
    (id,stripe_session_id,order_reference,customer_name,customer_phone,customer_email,delivery_address,postcode,delivery_zone,notes,subtotal_pence,delivery_pence,total_pence,payment_status,kitchen_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'paid','NEW')`)
    .bind(session.id,session.id,reference,String(m.customer_name||"Customer"),String(m.customer_phone||""),String(m.customer_email||session.customer_details?.email||""),String(m.delivery_address||""),String(m.postcode||""),String(m.delivery_zone||""),String(m.notes||""),subtotal,delivery,total).run();

  const order=await env.DB.prepare("SELECT id FROM orders WHERE stripe_session_id=?").bind(session.id).first();
  if(!order) throw new Error("Could not retrieve saved order");

  const existing=await env.DB.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id=?").bind(order.id).first();
  if(Number(existing?.count||0)>0 || !lines.some(x=>!x.name.startsWith(deliveryPrefix))) return;

  const statements=lines.filter(x=>!x.name.startsWith(deliveryPrefix)).map(line=>
    env.DB.prepare("INSERT INTO order_items (order_id,product_name,quantity,unit_price_pence,options) VALUES (?,?,?,?,?)")
      .bind(order.id,line.name,line.quantity,Math.round(line.amount/Math.max(1,line.quantity)),null)
  );
  if(statements.length) await env.DB.batch(statements);
}
async function login(req,env) {
  if(!env.DASHBOARD_PASSWORD) return json({error:"Dashboard password is not configured."},503);
  let body; try { body=await req.json(); } catch { return json({error:"Invalid request."},400); }
  if(!safeEqual(String(body.password||""),env.DASHBOARD_PASSWORD)) return json({error:"Incorrect password."},401);
  const token=await makeCookie(env.DASHBOARD_PASSWORD);
  return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":cookieHeader(token,43200)}});
}
async function retryPendingRefund(env,order) {
  if(!env.STRIPE_SECRET_KEY) return {httpStatus:503,error:"Stripe is not configured. No retry was made."};
  const key=env.STRIPE_SECRET_KEY;
  const sessionId=String(order.stripe_session_id||"");
  if((sessionId.startsWith("cs_test_")&&!key.startsWith("sk_test_"))||(sessionId.startsWith("cs_live_")&&!key.startsWith("sk_live_"))||!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return {httpStatus:409,error:"The Stripe payment reference does not match this environment. No retry was made."};
  const sr=await fetch("https://api.stripe.com/v1/checkout/sessions/"+encodeURIComponent(sessionId),{headers:{Authorization:"Bearer "+key}});
  const session=await sr.json();
  if(!sr.ok) return {httpStatus:502,error:session.error?.message||"Could not verify the Stripe payment."};
  if(session.payment_status!=="paid") return {httpStatus:409,error:"Stripe does not show this payment as paid."};
  const paymentIntent=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id;
  if(!paymentIntent) return {httpStatus:409,error:"Stripe did not provide a payment reference."};
  const lr=await fetch("https://api.stripe.com/v1/refunds?payment_intent="+encodeURIComponent(paymentIntent)+"&limit=100",{headers:{Authorization:"Bearer "+key}});
  const listed=await lr.json();
  if(!lr.ok) return {httpStatus:502,error:listed.error?.message||"Could not check the existing Stripe refunds."};
  if(listed.has_more) return {httpStatus:409,error:"There are many refund records for this payment. Please review it manually before retrying."};
  const refunds=Array.isArray(listed.data)?listed.data:[];
  const succeeded=refunds.filter(r=>r.status==="succeeded").reduce((n,r)=>n+Number(r.amount||0),0);
  const pending=refunds.filter(r=>r.status==="pending"||r.status==="requires_action");
  if(succeeded>=Number(order.total_pence||0)) {
    await env.DB.prepare("UPDATE orders SET payment_status='refunded',kitchen_status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(order.id).run();
    const emailStatus=await sendRefundEmail(env,order,order.total_pence);
    return {refundStatus:"refunded",emailStatus};
  }
  if(pending.length) {
    const ar=await fetch("https://api.stripe.com/v1/account",{headers:{Authorization:"Bearer "+key}});
    const account=ar.ok?await ar.json():{};
    const details=pending.map(r=>r.id+" "+r.status+" £"+(Number(r.amount||0)/100).toFixed(2)).join(", ");
    return {refundStatus:"refund_pending",message:"Stripe API check: account "+(account.id||"unavailable")+", payment "+paymentIntent.slice(-8)+", refund "+details+". No duplicate refund was created."};
  }
  const remaining=Math.max(0,Number(order.total_pence||0)-succeeded);
  if(!remaining) return {httpStatus:409,error:"The refund total could not be verified. Please review this payment manually."};
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS order_refund_attempts (order_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, stripe_refund_id TEXT, status TEXT NOT NULL, amount_pence INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(order_id,attempt_number))").run();
  let latest=await env.DB.prepare("SELECT attempt_number,idempotency_key,stripe_refund_id,status,amount_pence FROM order_refund_attempts WHERE order_id=? ORDER BY attempt_number DESC LIMIT 1").bind(order.id).first();
  if(latest?.stripe_refund_id) {
    const recorded=refunds.find(r=>r.id===latest.stripe_refund_id);
    if(recorded) {
      const recordedStatus=recorded.status==="succeeded"?"succeeded":recorded.status==="failed"||recorded.status==="canceled"?"failed": "pending";
      if(recordedStatus!==latest.status) {
        await env.DB.prepare("UPDATE order_refund_attempts SET status=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND attempt_number=?").bind(recordedStatus,order.id,latest.attempt_number).run();
        latest.status=recordedStatus;
      }
    }
  }
  if((latest?.status==="pending"||latest?.status==="succeeded")&&!refunds.some(r=>r.id===latest.stripe_refund_id)) {
    return {httpStatus:409,error:"Stripe's refund list does not match the last recorded attempt. No new refund was created; please review it manually."};
  }
  let attemptNumber,idempotencyKey,amountPence=remaining;
  if(latest?.status==="processing") {
    attemptNumber=latest.attempt_number;
    idempotencyKey=latest.idempotency_key;
    amountPence=latest.amount_pence;
  } else {
    attemptNumber=Number(latest?.attempt_number||0)+1;
    idempotencyKey="hungryfox-order-refund-"+order.id+"-retry-"+attemptNumber;
    await env.DB.prepare("INSERT OR IGNORE INTO order_refund_attempts (order_id,attempt_number,idempotency_key,status,amount_pence) VALUES (?,?,?,'processing',?)").bind(order.id,attemptNumber,idempotencyKey,amountPence).run();
    const claimed=await env.DB.prepare("SELECT attempt_number,idempotency_key,status,amount_pence FROM order_refund_attempts WHERE order_id=? AND attempt_number=?").bind(order.id,attemptNumber).first();
    if(!claimed) return {httpStatus:500,error:"Could not safely prepare the refund retry."};
    idempotencyKey=claimed.idempotency_key;
    amountPence=claimed.amount_pence;
    if(claimed.status!=="processing") return {refundStatus:claimed.status==="succeeded"?"refunded":claimed.status==="pending"?"refund_pending":"refund_failed"};
  }
  const form=new URLSearchParams();
  form.set("payment_intent",paymentIntent);
  form.set("amount",String(amountPence));
  const rr=await fetch("https://api.stripe.com/v1/refunds",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":idempotencyKey},body:form});
  const refund=await rr.json();
  if(!rr.ok) return {httpStatus:502,error:refund.error?.message||"Stripe could not process the refund retry. The attempt is held safely for another status check."};
  const status=refund.status==="succeeded"?"succeeded":refund.status==="failed"||refund.status==="canceled"?"failed":"pending";
  await env.DB.prepare("UPDATE order_refund_attempts SET stripe_refund_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND attempt_number=?").bind(refund.id||null,status,order.id,attemptNumber).run();
  if(status==="succeeded") {
    const totalRefunded=succeeded+(refunds.some(r=>r.id===refund.id)?0:Number(refund.amount||amountPence));
    if(totalRefunded>=Number(order.total_pence||0)) {
      await env.DB.prepare("UPDATE orders SET payment_status='refunded',kitchen_status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(order.id).run();
      const emailStatus=await sendRefundEmail(env,order,order.total_pence);
      return {refundStatus:"refunded",emailStatus};
    }
    await env.DB.prepare("UPDATE orders SET payment_status='refund_pending',kitchen_status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(order.id).run();
    return {refundStatus:"refund_pending",message:"Stripe issued a partial refund. The remaining balance still needs to be refunded."};
  }
  if(status==="failed") return {refundStatus:"refund_failed",message:"Stripe declined this retry. You can check the payment and try again if appropriate."};
  await env.DB.prepare("UPDATE orders SET payment_status='refund_pending',kitchen_status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(order.id).run();
  return {refundStatus:"refund_pending",message:"Stripe is still processing the refund. No duplicate refund will be created while it is pending."};
}
async function api(req,env,url) {
  if(!await authorised(req,env)) return json({error:"Please sign in again."},401);
  if(req.method==="GET"&&url.pathname==="/kitchen/api/orders") {
    const result=await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100").all();
    const orders=result.results||[];
    for(const o of orders) {
      const items=await env.DB.prepare("SELECT product_name,quantity,unit_price_pence,options FROM order_items WHERE order_id=? ORDER BY id").bind(o.id).all();
      o.items=items.results||[];
    }
    return json({orders});
  }
  if(req.method==="POST"&&url.pathname==="/kitchen/api/status") {
    let body; try { body=await req.json(); } catch { return json({error:"Invalid request."},400); }
    if(!body.id||!STATUSES.has(body.status)) return json({error:"Invalid order status."},400);
    const result=await env.DB.prepare("UPDATE orders SET kitchen_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status='paid' AND kitchen_status IN ('NEW','READY')").bind(body.status,body.id).run();
    if(!result.meta?.changes) return json({error:"Order not found or status can no longer be changed."},404);
    return json({ok:true});
  }
  if(req.method==="POST"&&url.pathname==="/kitchen/api/retry-refund") {
    let body; try { body=await req.json(); } catch { return json({error:"Invalid request."},400); }
    if(!body.id) return json({error:"Order reference is missing."},400);
    const order=await env.DB.prepare("SELECT id,stripe_session_id,order_reference,customer_name,customer_email,total_pence,payment_status,kitchen_status FROM orders WHERE id=?").bind(body.id).first();
    if(!order) return json({error:"Order not found."},404);
    if(order.payment_status==="refunded") { const emailStatus=await sendRefundEmail(env,order,order.total_pence); return json({ok:true,refundStatus:"refunded",emailStatus}); }
    if(order.payment_status!=="refund_pending"||order.kitchen_status!=="CANCELLED") return json({error:"Only cancelled orders with a pending refund can be checked or retried."},409);
    try {
      const result=await retryPendingRefund(env,order);
      if(result.httpStatus) return json({error:result.error},result.httpStatus);
      return json({ok:true,...result});
    } catch(error) {
      return json({error:"Could not safely check the refund. No additional refund was intentionally created. Please try again shortly."},502);
    }
  }
  if(req.method==="POST"&&url.pathname==="/kitchen/api/cancel") {
    let body; try { body=await req.json(); } catch { return json({error:"Invalid request."},400); }
    if(!body.id) return json({error:"Order reference is missing."},400);
    const order=await env.DB.prepare("SELECT id,stripe_session_id,order_reference,customer_name,customer_email,total_pence,payment_status,kitchen_status FROM orders WHERE id=?").bind(body.id).first();
    if(!order) return json({error:"Order not found."},404);
    if(order.payment_status==="refunded") { const emailStatus=await sendRefundEmail(env,order,order.total_pence); return json({ok:true,refundStatus:"refunded",emailStatus}); }
    if(!["paid","refund_pending"].includes(order.payment_status)) return json({error:"This order is not eligible for a refund."},409);
    if(!["NEW","READY"].includes(order.kitchen_status)) return json({error:"This order can no longer be cancelled from the kitchen dashboard."},409);
    if(!env.STRIPE_SECRET_KEY) return json({error:"Stripe is not configured. No refund was made."},503);
    const sessionId=String(order.stripe_session_id||"");
    const key=env.STRIPE_SECRET_KEY;
    if((sessionId.startsWith("cs_test_")&&!key.startsWith("sk_test_"))||(sessionId.startsWith("cs_live_")&&!key.startsWith("sk_live_"))||!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return json({error:"The Stripe payment reference does not match this environment. No refund was made."},409);
    const sr=await fetch("https://api.stripe.com/v1/checkout/sessions/"+encodeURIComponent(sessionId),{headers:{Authorization:"Bearer "+key}});
    const session=await sr.json();
    if(!sr.ok) return json({error:session.error?.message||"Could not verify the Stripe payment. No refund was made."},502);
    if(session.payment_status!=="paid") return json({error:"Stripe does not show this payment as paid. No refund was made."},409);
    const paymentIntent=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id;
    if(!paymentIntent) return json({error:"Stripe did not provide a payment reference. No refund was made."},409);
    const form=new URLSearchParams(); form.set("payment_intent",paymentIntent);
    const rr=await fetch("https://api.stripe.com/v1/refunds",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":"hungryfox-order-refund-"+order.id},body:form});
    const refund=await rr.json();
    if(!rr.ok) return json({error:refund.error?.message||"Stripe could not issue the refund. The order has not been cancelled."},502);
    if(refund.status==="failed"||refund.status==="canceled") return json({error:"Stripe did not complete the refund. The order has not been cancelled."},502);
    const paymentStatus=refund.status==="succeeded"?"refunded":"refund_pending";
    await env.DB.prepare("UPDATE orders SET kitchen_status='CANCELLED',payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(paymentStatus,order.id).run();
    const emailStatus=paymentStatus==="refunded"?await sendRefundEmail(env,order,refund.amount):"not_sent_refund_pending";
    return json({ok:true,refundStatus:paymentStatus,emailStatus});
  }
  return json({error:"Not found."},404);
}
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Hungry Fox — Dashboard</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f1eb;color:#211b18;font:15px Arial,sans-serif}header{background:#211b18;color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center}.brand{display:flex;align-items:center;gap:12px}.brand img{width:46px;height:46px;object-fit:contain;background:#f7f0e5;border-radius:8px;padding:3px}h1{font-size:20px;margin:0}main{max-width:1100px;margin:24px auto;padding:0 14px}.panel,.order{background:white;border-radius:10px;padding:18px;margin-bottom:14px;box-shadow:0 2px 9px #0000000d}input,button,select{font:inherit;padding:11px;border-radius:7px;border:1px solid #ccc}button{cursor:pointer;background:#211b18;color:white;border:0;margin:4px 4px 4px 0}button.secondary{background:#eee;color:#211b18}button.warn{background:#a12c20}.hidden{display:none}.muted{color:#6b625b}.orderhead{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.items{padding-left:18px}.pill{font-size:13px;font-weight:700;min-width:150px;min-height:38px;padding:8px 14px;border-radius:4px;background:#000;color:#fff;display:inline-flex;align-items:center;justify-content:center;text-align:center;letter-spacing:.4px}.details{line-height:1.6}.actions{margin-top:12px}.empty{text-align:center;padding:35px}.login{max-width:380px;margin:12vh auto}.login input{width:100%;margin:8px 0}.login button{width:100%}@media print{header,.no-print,#login{display:none!important}body{background:white}.order{box-shadow:none;break-inside:avoid;border:1px solid #ddd}main{max-width:none;margin:0;padding:0}}
</style></head><body><header><div class="brand"><img src="https://thehungryfox.co.uk/hungry-fox-logo-dark.png" alt="The Hungry Fox logo"><h1>THE HUNGRY FOX — DASHBOARD</h1></div><button id="logout" class="secondary hidden">Sign out</button></header><main><section id="login" class="panel login"><h2>Staff sign in</h2><form id="loginForm"><input id="password" type="password" placeholder="Dashboard password" autocomplete="current-password" required><button>Sign in</button><p id="loginError" class="muted"></p></form></section><section id="app" class="hidden"><div class="panel no-print"><strong>THE HUNGRY FOX ORDERS</strong> <span class="muted">— updates automatically every 5 seconds</span> <button id="sound" class="secondary">Enable sound</button><button id="checkPrinter" class="secondary">Check Bluetooth printer</button><button id="autoPrint" class="secondary">Auto print: OFF</button><button onclick="window.print()" class="secondary">Print orders</button><span id="printerStatus" class="muted">Bluetooth printer not checked</span><span id="last" class="muted"></span></div><div id="orders"></div></section></main><script>
const $=id=>document.getElementById(id);let known=new Set(),soundOn=false,ctx=null,first=true,latestOrders=[],printerReady=false,printerName="",processingPending=false,autoPrintEnabled=localStorage.getItem("hf_auto_print")==="true";
async function request(path,options={}){const r=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d}
function beep(){if(!soundOn)return;try{ctx=ctx||new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=880;g.gain.value=.12;o.start();o.stop(ctx.currentTime+.22)}catch{}}
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(n){return "£"+(Number(n||0)/100).toFixed(2)}
function receiptParts(item){
 const raw=String(item.product_name||"Hungry Fox item");
 const split=raw.indexOf(" — ");
 return split<0?{name:raw,options:String(item.options||"")}:{name:raw.slice(0,split),options:raw.slice(split+3)};
}
function receiptDate(order){
 const raw=String(order.created_at||"").replace(" ","T");
 const date=new Date(raw.endsWith("Z")?raw:raw+"Z");
 return isNaN(date.getTime())?"":date.toLocaleString();
}
function receiptContent(order){
 const blocks=[
  {type:"text",text:"THE HUNGRY FOX",align:"center",bold:true,size:"large"},
  {type:"text",text:"CRACKING CHICKEN. INSANE FLAVORS.",align:"center",size:"small"},
  {type:"divider",char:"="},
  {type:"text",text:"CUSTOMER RECEIPT",align:"center",bold:true},
  {type:"row",left:"ORDER #"+String(order.order_reference||order.id),right:"PAID",bold:true},
  {type:"text",text:receiptDate(order),align:"center",size:"small"},
  {type:"divider"},
  {type:"text",text:"DELIVERY DETAILS",bold:true},
  {type:"text",text:String(order.customer_name||"Customer")},
  {type:"text",text:String(order.delivery_address||"")},
  {type:"text",text:String(order.postcode||"")},
  {type:"text",text:"Phone: "+String(order.customer_phone||"")},
  {type:"divider"},
  {type:"text",text:"YOUR ORDER",bold:true}
 ];
 (order.items||[]).forEach(function(item){
  const part=receiptParts(item);
  blocks.push({type:"row",left:String(item.quantity||1)+" x "+part.name,right:money(Number(item.unit_price_pence||0)*Number(item.quantity||1))});
  if(part.options) blocks.push({type:"text",text:part.options,size:"small"});
 });
 blocks.push({type:"divider"});
 blocks.push({type:"row",left:"Subtotal",right:money(order.subtotal_pence)});
 blocks.push({type:"row",left:"Delivery & adjustment",right:money(order.delivery_pence)});
 blocks.push({type:"row",left:"TOTAL PAID",right:money(order.total_pence),bold:true});
 blocks.push({type:"text",text:"PAID ONLINE",align:"center",bold:true});
 if(order.notes) {
  blocks.push({type:"divider"});
  blocks.push({type:"text",text:"ORDER NOTES",bold:true});
  blocks.push({type:"text",text:String(order.notes)});
 }
 blocks.push({type:"divider"});
 blocks.push({type:"text",text:"THANK YOU FOR ORDERING!",align:"center",bold:true});
 blocks.push({type:"text",text:"thehungryfox.co.uk",align:"center"});
 blocks.push({type:"text",text:"Instagram & TikTok: @thehungryfox2026",align:"center",size:"small"});
 blocks.push({type:"feed",lines:3});
 return blocks;
}
function receiptHtml(order){
 const itemHtml=(order.items||[]).map(function(item){
  const part=receiptParts(item);
  return "<div class='item'><div class='line'><span>"+esc(String(item.quantity||1)+" × "+part.name)+"</span><strong>"+esc(money(Number(item.unit_price_pence||0)*Number(item.quantity||1)))+"</strong></div>"+(part.options?"<div class='option'>"+esc(part.options)+"</div>":"")+"</div>";
 }).join("");
 const note=order.notes?"<section><strong>ORDER NOTES</strong><p>"+esc(order.notes)+"</p></section>":"";
 return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Hungry Fox receipt</title><style>*{box-sizing:border-box}body{margin:0;padding:16px;background:#eee8df;color:#211b18;font:14px Arial,sans-serif}.receipt{width:80mm;max-width:100%;margin:0 auto;background:#fff;padding:5mm 4mm}.brand{text-align:center;font-size:21px;font-weight:900;letter-spacing:1px}.tag{text-align:center;font-size:9px;margin:4px 0 12px}.center{text-align:center}.small{font-size:11px;color:#554c45}.rule{border:0;border-top:1px dashed #555;margin:10px 0}.line{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.item{margin:8px 0}.option{font-size:11px;color:#514941;margin:3px 0 0 8px;line-height:1.35;overflow-wrap:anywhere}.section{font-weight:bold;margin:8px 0 5px}.details{line-height:1.5;overflow-wrap:anywhere}.totals .line{margin:5px 0}.grand{font-size:16px;font-weight:bold;margin-top:8px}.footer{text-align:center;line-height:1.5;margin-top:12px;font-size:11px}.paid{font-weight:bold;text-align:center;border:1px solid #211b18;padding:5px;margin-top:10px}.actions{max-width:80mm;margin:12px auto;text-align:center}.actions button{padding:10px 18px;background:#211b18;color:white;border:0;border-radius:6px;font-weight:bold}@media print{body{padding:0;background:white}.receipt{width:80mm;max-width:none;margin:0;padding:3mm 3mm}.actions{display:none}@page{size:80mm auto;margin:0}}</style></head><body><div class='receipt'><div class='brand'>THE HUNGRY FOX</div><div class='tag'>CRACKING CHICKEN. INSANE FLAVORS.</div><hr class='rule'><div class='center'><strong>CUSTOMER RECEIPT</strong><div><strong>ORDER #"+esc(order.order_reference||order.id)+"</strong></div><div class='small'>"+esc(receiptDate(order))+"</div></div><hr class='rule'><div class='section'>DELIVERY DETAILS</div><div class='details'>"+esc(order.customer_name||"Customer")+"<br>"+esc(order.delivery_address||"")+"<br>"+esc(order.postcode||"")+"<br>Phone: "+esc(order.customer_phone||"")+"</div><hr class='rule'><div class='section'>YOUR ORDER</div>"+itemHtml+"<hr class='rule'><div class='totals'><div class='line'><span>Subtotal</span><span>"+esc(money(order.subtotal_pence))+"</span></div><div class='line'><span>Delivery & adjustment</span><span>"+esc(money(order.delivery_pence))+"</span></div><div class='line grand'><span>TOTAL PAID</span><span>"+esc(money(order.total_pence))+"</span></div></div><div class='paid'>PAID ONLINE</div>"+note+"<hr class='rule'><div class='footer'><strong>THANK YOU FOR ORDERING!</strong><br>thehungryfox.co.uk<br>Instagram & TikTok<br>@thehungryfox2026</div></div><div class='actions'><button onclick='window.print()'>Print receipt</button></div></body></html>";
}
function previewReceipt(id){
 const order=latestOrders.find(function(x){return x.id===id;});
 if(!order){alert("Order details are not loaded. Refresh and try again.");return;}
 const win=window.open("","_blank","width=440,height=850");
 if(!win){alert("Please allow pop-ups for the kitchen dashboard to preview the receipt.");return;}
 win.document.open();win.document.write(receiptHtml(order));win.document.close();
}
function printStateMap(){
 try{return JSON.parse(localStorage.getItem("hf_receipt_print_states")||"{}")}catch{return {}}
}
function savePrintState(id,state){
 const map=printStateMap();map[id]={state:state,updatedAt:Date.now()};
 try{localStorage.setItem("hf_receipt_print_states",JSON.stringify(map))}catch{}
}
function pendingPrintIds(){
 try{return JSON.parse(localStorage.getItem("hf_receipt_auto_queue")||"[]")}catch{return []}
}
function savePendingPrintIds(ids){
 try{localStorage.setItem("hf_receipt_auto_queue",JSON.stringify(ids))}catch{}
}
function setPrinterMessage(message){
 const node=$("printerStatus");if(node)node.textContent=message;
}
function setAutoPrintButton(){
 const node=$("autoPrint");if(node)node.textContent="Auto print: "+(autoPrintEnabled?"ON":"OFF");
}
async function checkPrinter(){
 try{
  const response=await fetch("http://localhost:9100/health",{signal:AbortSignal.timeout(1800)});
  if(!response.ok)throw new Error("Bridge not ready");
  const data=await response.json();
  printerReady=!!data.printer?.connected;
  printerName=data.printer?.name||"";
  setPrinterMessage(printerReady?"Bluetooth printer connected"+(printerName?" · "+printerName:""):"Print bridge found, but no printer is selected");
 }catch(error){
  printerReady=false;printerName="";
  setPrinterMessage("Bluetooth print bridge not detected on this tablet");
 }
 if(printerReady&&autoPrintEnabled) await processPendingAutoPrint();
}
async function sendReceiptToPrinter(order){
 const response=await fetch("http://localhost:9100/print",{
  method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({paperWidth:80,cut:true,reference:"Order #"+String(order.order_reference||order.id),content:receiptContent(order)})
 });
 const data=await response.json().catch(function(){return {}});
 if(!response.ok)throw new Error(data.fix||data.detail||data.error||"The printer could not complete this receipt.");
 return data;
}
async function printReceipt(id){
 const order=latestOrders.find(function(x){return x.id===id;});
 if(!order){alert("Order details are not loaded. Refresh and try again.");return;}
 const prior=printStateMap()[id];
 if(prior?.state==="printed"&&!confirm("This receipt has already printed. Print another copy?"))return;
 if(!printerReady)await checkPrinter();
 if(!printerReady){previewReceipt(id);alert("The Bluetooth print bridge is not connected. The receipt preview has opened. When you buy the printer, install Cleanter on the Android tablet, pair a Bluetooth Classic ESC/POS printer and select it.");return;}
 try{
  await sendReceiptToPrinter(order);savePrintState(id,"printed");
  const pending=pendingPrintIds().filter(function(x){return x!==id});savePendingPrintIds(pending);
  alert("Receipt sent to the Bluetooth printer.");
 }catch(error){savePrintState(id,"failed");alert(error.message+" Check the printer before trying again, to avoid duplicate copies.");}
}
async function processPendingAutoPrint(){
 if(processingPending||!printerReady||!autoPrintEnabled)return;
 processingPending=true;
 try{
  const ids=pendingPrintIds();
  for(const id of ids){
   const order=latestOrders.find(function(x){return x.id===id;});
   if(!order)continue;
   if(printStateMap()[id]?.state==="printed"||printStateMap()[id]?.state==="failed")continue;
   try{await sendReceiptToPrinter(order);savePrintState(id,"printed");}
   catch(error){savePrintState(id,"failed");setPrinterMessage("Auto-print failed for order #"+String(order.order_reference||order.id)+". Check printer; use Print Receipt to retry.");}
  }
  savePendingPrintIds(ids.filter(function(id){const state=printStateMap()[id]?.state;return state!=="printed"&&state!=="failed";}));
 }finally{processingPending=false;}
}
function queueAutoPrint(orders){
 const ids=pendingPrintIds();
 orders.forEach(function(order){
  if(!ids.includes(order.id)&&!["printed","failed"].includes(printStateMap()[order.id]?.state))ids.push(order.id);
 });
 savePendingPrintIds(ids);
 if(printerReady)processPendingAutoPrint();
}
async function load(){try{const d=await request("/kitchen/api/orders");const orders=d.orders||[];latestOrders=orders;const fresh=orders.filter(o=>!known.has(o.id)&&o.kitchen_status==="NEW");if(!first&&fresh.length){beep();if(autoPrintEnabled)queueAutoPrint(fresh)}known=new Set(orders.map(o=>o.id));first=false;$("last").textContent=" Last refreshed "+new Date().toLocaleTimeString();$("orders").innerHTML=orders.length?orders.map(o=>\`<article class="order"><div class="orderhead"><div><h2>Order #\${esc(o.order_reference)}</h2><span class="muted">\${new Date(o.created_at.replace(" ","T")+"Z").toLocaleString()}</span></div><span class="pill">\${statusLabel(o)}</span></div><ul class="items">\${(o.items||[]).map(i=>\`<li><strong>\${i.quantity} × \${esc(i.product_name)}</strong> — \${money(i.unit_price_pence*i.quantity)} \${i.options?"<br>"+esc(i.options):""}</li>\`).join("")}</ul><div class="details"><strong>Customer:</strong> \${esc(o.customer_name)}<br><strong>Phone:</strong> \${esc(o.customer_phone)}<br><strong>Email:</strong> \${esc(o.customer_email)}<br><strong>Delivery:</strong> \${esc(o.delivery_address)}, \${esc(o.postcode)} (\${esc(o.delivery_zone)})<br><strong>Notes:</strong> \${esc(o.notes)||"None"}<br><strong>Subtotal:</strong> \${money(o.subtotal_pence)} · <strong>Delivery:</strong> \${money(o.delivery_pence)} · <strong>Total:</strong> <strong>\${money(o.total_pence)}</strong></div><div class="actions no-print"><button class="secondary" onclick="printReceipt(&#39;\${esc(o.id)}&#39;)">Print customer receipt</button>\${o.kitchen_status==="NEW"?button(o,"READY","Ready",""):o.kitchen_status==="READY"?button(o,"OUT_FOR_DELIVERY","Start Delivery",""):""}\${["NEW","READY"].includes(o.kitchen_status)?cancelButton(o):""}\${o.kitchen_status==="CANCELLED"&&o.payment_status==="refund_pending"?retryRefundButton(o):""}</div></article>\`).join(""):'<div class="panel empty">No paid website orders yet.</div>'}catch(e){if(e.message.includes("sign in"))showLogin();}}
function statusLabel(o){if(o.kitchen_status==="OUT_FOR_DELIVERY")return "OUT FOR DELIVERY";if(o.kitchen_status==="CANCELLED")return o.payment_status==="refunded"?"CANCELLED · REFUNDED":"CANCELLED · REFUND PENDING";return esc(String(o.kitchen_status||"").replaceAll("_"," "));}
function button(o,status,label,cls){return '<button class="'+cls+'" onclick="changeStatus(&#39;'+esc(o.id)+'&#39;,&#39;'+status+'&#39;)">'+label+'</button>'}
function cancelButton(o){return '<button class="warn" onclick="cancelOrder(&#39;'+esc(o.id)+'&#39;)">Cancel Order</button>'}
function retryRefundButton(o){return '<button class="warn" onclick="retryRefund(&#39;'+esc(o.id)+'&#39;)">Check / Retry Refund</button>'}
async function retryRefund(id){if(!confirm("Check Stripe for the existing refund. If it failed or was not created, this will safely retry the outstanding amount. Continue?"))return;try{const result=await request("/kitchen/api/retry-refund",{method:"POST",body:JSON.stringify({id})});alert(result.refundStatus==="refunded"?(result.emailStatus==="sent"?"Refund confirmed. Customer email sent.":"Refund confirmed. Customer email status: "+result.emailStatus+"."):result.message||"Refund status: "+result.refundStatus+".");await load()}catch(e){alert(e.message)}}
async function changeStatus(id,status){try{await request("/kitchen/api/status",{method:"POST",body:JSON.stringify({id,status})});await load()}catch(e){alert(e.message)}}
async function cancelOrder(id){if(!confirm("Confirm you have contacted the customer and they have declined a substitute. This will issue a FULL refund through Stripe. Continue?"))return;try{const result=await request("/kitchen/api/cancel",{method:"POST",body:JSON.stringify({id})});alert(result.refundStatus!=="refunded"?"Order cancelled. Stripe refund is pending.":result.emailStatus==="sent"?"Order cancelled. Full refund issued and customer email sent.":result.emailStatus==="failed"?"Refund issued, but the customer email could not be sent.":result.emailStatus==="not_configured"?"Refund issued. Customer email was not sent because email is not configured in this environment.":"Refund issued. Customer email status: "+result.emailStatus+".");await load()}catch(e){alert(e.message)}}
function showLogin(){$("login").classList.remove("hidden");$("app").classList.add("hidden");$("logout").classList.add("hidden")}
function showApp(){$("login").classList.add("hidden");$("app").classList.remove("hidden");$("logout").classList.remove("hidden");setAutoPrintButton();checkPrinter();load()}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginError").textContent="";try{await request("/kitchen/login",{method:"POST",body:JSON.stringify({password:$("password").value})});$("password").value="";showApp()}catch(e){$("loginError").textContent=e.message}});
$("logout").addEventListener("click",async()=>{await fetch("/kitchen/logout",{method:"POST"});showLogin()});
$("sound").addEventListener("click",()=>{soundOn=true;ctx=ctx||new(window.AudioContext||window.webkitAudioContext)();$("sound").textContent="Sound enabled";beep()});
$("checkPrinter").addEventListener("click",checkPrinter);
$("autoPrint").addEventListener("click",()=>{autoPrintEnabled=!autoPrintEnabled;localStorage.setItem("hf_auto_print",String(autoPrintEnabled));setAutoPrintButton();if(autoPrintEnabled){checkPrinter();}});
fetch("/kitchen/api/orders").then(r=>{if(r.ok)showApp()}).catch(()=>{});setInterval(()=>{if(!$("app").classList.contains("hidden"))load()},5000);setInterval(()=>{if(!$("app").classList.contains("hidden"))checkPrinter()},15000);
</script></body></html>`;
export async function kitchenFetch(req,env,url) {
  if(url.pathname==="/kitchen"&&req.method==="GET") return new Response(PAGE,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  if(url.pathname==="/kitchen/login"&&req.method==="POST") return login(req,env);
  if(url.pathname==="/kitchen/logout"&&req.method==="POST") return new Response("ok",{headers:{"Set-Cookie":cookieHeader("",0),"Cache-Control":"no-store"}});
  if(url.pathname.startsWith("/kitchen/api/")) return api(req,env,url);
  return null;
}
