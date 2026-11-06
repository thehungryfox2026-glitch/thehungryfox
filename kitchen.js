const STATUSES = new Set(["NEW","ACCEPTED","PREPARING","READY","DISPATCHED","REJECTED"]);
const COOKIE = "hf_kitchen_session";
const enc = new TextEncoder();

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers: {"Content-Type":"application/json","Cache-Control":"no-store"}});
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
    const result=await env.DB.prepare("UPDATE orders SET kitchen_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status='paid'").bind(body.status,body.id).run();
    if(!result.meta?.changes) return json({error:"Order not found."},404);
    return json({ok:true});
  }
  return json({error:"Not found."},404);
}
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Hungry Fox — Kitchen</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f1eb;color:#211b18;font:15px Arial,sans-serif}header{background:#211b18;color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center}h1{font-size:20px;margin:0}main{max-width:1100px;margin:24px auto;padding:0 14px}.panel,.order{background:white;border-radius:10px;padding:18px;margin-bottom:14px;box-shadow:0 2px 9px #0000000d}input,button,select{font:inherit;padding:11px;border-radius:7px;border:1px solid #ccc}button{cursor:pointer;background:#211b18;color:white;border:0;margin:4px 4px 4px 0}button.secondary{background:#eee;color:#211b18}button.warn{background:#a12c20}.hidden{display:none}.muted{color:#6b625b}.orderhead{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.items{padding-left:18px}.pill{font-size:12px;padding:5px 8px;border-radius:20px;background:#eee}.details{line-height:1.6}.actions{margin-top:12px}.empty{text-align:center;padding:35px}.login{max-width:380px;margin:12vh auto}.login input{width:100%;margin:8px 0}.login button{width:100%}@media print{header,.no-print,#login{display:none!important}body{background:white}.order{box-shadow:none;break-inside:avoid;border:1px solid #ddd}main{max-width:none;margin:0;padding:0}}
</style></head><body><header><h1>THE HUNGRY FOX — KITCHEN ORDERS</h1><button id="logout" class="secondary hidden">Sign out</button></header><main><section id="login" class="panel login"><h2>Staff sign in</h2><form id="loginForm"><input id="password" type="password" placeholder="Dashboard password" autocomplete="current-password" required><button>Sign in</button><p id="loginError" class="muted"></p></form></section><section id="app" class="hidden"><div class="panel no-print"><strong>Website orders</strong> <span class="muted">— updates automatically every 5 seconds</span> <button id="sound" class="secondary">Enable sound</button><button onclick="window.print()" class="secondary">Print orders</button><span id="last" class="muted"></span></div><div id="orders"></div></section></main><script>
const $=id=>document.getElementById(id);let known=new Set(),soundOn=false,ctx=null,first=true;
async function request(path,options={}){const r=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d}
function beep(){if(!soundOn)return;try{ctx=ctx||new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=880;g.gain.value=.12;o.start();o.stop(ctx.currentTime+.22)}catch{}}
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(n){return "£"+(Number(n||0)/100).toFixed(2)}
async function load(){try{const d=await request("/kitchen/api/orders");const orders=d.orders||[];const fresh=orders.filter(o=>!known.has(o.id)&&o.kitchen_status==="NEW");if(!first&&fresh.length)beep();known=new Set(orders.map(o=>o.id));first=false;$("last").textContent=" Last refreshed "+new Date().toLocaleTimeString();$("orders").innerHTML=orders.length?orders.map(o=>\`<article class="order"><div class="orderhead"><div><h2>Order #\${esc(o.order_reference)}</h2><span class="muted">\${new Date(o.created_at.replace(" ","T")+"Z").toLocaleString()}</span></div><span class="pill">\${esc(o.kitchen_status)}</span></div><ul class="items">\${(o.items||[]).map(i=>\`<li><strong>\${i.quantity} × \${esc(i.product_name)}</strong> — \${money(i.unit_price_pence*i.quantity)} \${i.options?"<br>"+esc(i.options):""}</li>\`).join("")}</ul><div class="details"><strong>Customer:</strong> \${esc(o.customer_name)}<br><strong>Phone:</strong> \${esc(o.customer_phone)}<br><strong>Email:</strong> \${esc(o.customer_email)}<br><strong>Delivery:</strong> \${esc(o.delivery_address)}, \${esc(o.postcode)} (\${esc(o.delivery_zone)})<br><strong>Notes:</strong> \${esc(o.notes)||"None"}<br><strong>Subtotal:</strong> \${money(o.subtotal_pence)} · <strong>Delivery:</strong> \${money(o.delivery_pence)} · <strong>Total:</strong> <strong>\${money(o.total_pence)}</strong></div><div class="actions no-print">\${button(o,"ACCEPTED","Accept","")}\${button(o,"PREPARING","Preparing","")}\${button(o,"READY","Ready","")}\${button(o,"DISPATCHED","Dispatched","")}\${button(o,"REJECTED","Reject","warn")}</div></article>\`).join(""):'<div class="panel empty">No paid website orders yet.</div>'}catch(e){if(e.message.includes("sign in"))showLogin();}}
function button(o,status,label,cls){return \`<button class="\${cls}" onclick="changeStatus('\${esc(o.id)}','\${status}')">\${label}</button>\`}
async function changeStatus(id,status){try{await request("/kitchen/api/status",{method:"POST",body:JSON.stringify({id,status})});await load()}catch(e){alert(e.message)}}
function showLogin(){$("login").classList.remove("hidden");$("app").classList.add("hidden");$("logout").classList.add("hidden")}
function showApp(){$("login").classList.add("hidden");$("app").classList.remove("hidden");$("logout").classList.remove("hidden");load()}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginError").textContent="";try{await request("/kitchen/login",{method:"POST",body:JSON.stringify({password:$("password").value})});$("password").value="";showApp()}catch(e){$("loginError").textContent=e.message}});
$("logout").addEventListener("click",async()=>{await fetch("/kitchen/logout",{method:"POST"});showLogin()});
$("sound").addEventListener("click",()=>{soundOn=true;ctx=ctx||new(window.AudioContext||window.webkitAudioContext)();$("sound").textContent="Sound enabled";beep()});
fetch("/kitchen/api/orders").then(r=>{if(r.ok)showApp()}).catch(()=>{});setInterval(()=>{if(!$("app").classList.contains("hidden"))load()},5000);
</script></body></html>`;
export async function kitchenFetch(req,env,url) {
  if(url.pathname==="/kitchen"&&req.method==="GET") return new Response(PAGE,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  if(url.pathname==="/kitchen/login"&&req.method==="POST") return login(req,env);
  if(url.pathname==="/kitchen/logout"&&req.method==="POST") return new Response("ok",{headers:{"Set-Cookie":cookieHeader("",0),"Cache-Control":"no-store"}});
  if(url.pathname.startsWith("/kitchen/api/")) return api(req,env,url);
  return null;
}
