'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const code=fs.readFileSync('worker.js','utf8');
const start=code.indexOf('async function stripeRefundRequest(');
const end=code.indexOf('async function kitchenRefundDetails(',start);
assert.ok(start>=0&&end>start,'Refund functions must exist');
const source=code.slice(start,end);
let scenario={};
const audit=[];
const fetchMock=async (url,options)=>{
 assert.equal(options.headers.Authorization,'Bearer sk_test_mock');
 if(url.includes('/checkout/sessions/'))return {ok:true,json:async()=>({id:scenario.sessionId??'cs_test_123',payment_status:scenario.paymentStatus??'paid',currency:scenario.sessionCurrency??'gbp',payment_intent:'pi_test_123',amount_total:scenario.sessionAmount??2000})};
 if(url.includes('/refunds?'))return {ok:true,json:async()=>({data:(scenario.refunds||[]).map(r=>({payment_intent:'pi_test_123',currency:'gbp',...r})),has_more:!!scenario.has_more})};
 throw new Error('Unexpected Stripe request: '+url);
};
const DB={prepare(sql){
 return {bind(...args){return {async run(){audit.push({sql,args});return {meta:{changes:1}}}}}};
}};
const ctx=vm.createContext({fetch:fetchMock,URLSearchParams,encodeURIComponent,crypto:require('node:crypto').webcrypto});
vm.runInContext(source,ctx,{filename:'refund-functions.js'});
const state=vm.runInContext('refundState',ctx);

const refundStart=code.indexOf('async function kitchenRefund(req,env,id){');
const refundEnd=code.indexOf('async function kitchenOrders(env)',refundStart);
assert.ok(refundStart>=0&&refundEnd>refundStart,'Refund POST handler must exist');
const postCtx=vm.createContext({
 Response,crypto:require('node:crypto').webcrypto,URLSearchParams,
 refundState:async()=>({payment_intent:'pi_test_123',refunded_pence:0,pending_pence:0,refundable_pence:2000}),
 reconcileFullRefundLoyalty:async()=>{},
 stripeRefundRequest:async(path,env,init)=>{
  assert.equal(path,'refunds');
  assert.equal(init.method,'POST');
  assert.equal(init.headers['Content-Type'],'application/x-www-form-urlencoded');
  assert.ok(init.headers['Idempotency-Key'].startsWith('hungryfox-'));
  assert.equal(new URLSearchParams(init.body).get('amount'),'500');
  return {id:'re_test_post',status:'succeeded'};
 }
});
vm.runInContext(code.slice(refundStart,refundEnd),postCtx);
const postRefund=vm.runInContext('kitchenRefund',postCtx);
async function checkPost(){
 let inserted=0,loyaltyReads=0,failedUpdates=0;
 const env={STRIPE_SECRET_KEY:'sk_test_mock',DB:{prepare(sql){return {bind(...args){return {
  async first(){
   if(sql.includes('FROM orders'))return {id:'order_test',stripe_session_id:'cs_test_123',total_pence:2000,order_reference:'TEST'};
   if(sql.includes('FROM order_refunds'))return null;
   throw Error('Unexpected first SQL: '+sql);
  },
  async run(){if(sql.includes('INSERT INTO order_refunds'))inserted++;if(sql.includes("SET status='failed'"))failedUpdates++;return {meta:{changes:1}}}
 }}}}},LOYALTY_DB:{prepare(sql){return {bind(){return {async first(){loyaltyReads++;return null}}}}}}};
 const request=body=>({json:async()=>body});
 let response=await postRefund(request({amount_pence:500,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,200);
 assert.equal((await response.json()).refund_id,'re_test_post');
 assert.equal(inserted,1);
 assert.equal(loyaltyReads,1);
 const savedLoyalty=env.LOYALTY_DB;delete env.LOYALTY_DB;
 response=await postRefund(request({amount_pence:500,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,503,'Missing loyalty database must block refunds');
 assert.equal(inserted,1,'Missing loyalty database must not issue refunds');
 env.LOYALTY_DB=savedLoyalty;
 response=await postRefund(request({amount_pence:2001,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,409);
 response=await postRefund(request({amount_pence:-1,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,400);
 env.LOYALTY_DB.prepare=()=>({bind:()=>({first:async()=>({id:'loyalty_test'})})});
 response=await postRefund(request({amount_pence:500,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,200,'Partial refund must be allowed for loyalty-linked orders');
 assert.equal(inserted,2,'Loyalty-linked partial refund must reach Stripe');
 env.LOYALTY_DB.prepare=()=>({bind:()=>({first:async()=>null})});
 postCtx.stripeRefundRequest=async()=>{const e=new Error('Invalid request');e.stripeStatus=400;throw e};
 response=await postRefund(request({amount_pence:500,reason:'duplicate'}),env,'order_test');
 assert.equal(response.status,422,'Definitive Stripe rejection should be reported');
 assert.equal(failedUpdates,1,'Definitive rejection must release refund lock');
 postCtx.stripeRefundRequest=async()=>{throw new Error('Network timeout')};
 response=await postRefund(request({amount_pence:500,reason:'duplicate'}),env,'order_test');
 assert.equal(response.status,502,'Ambiguous Stripe failure must not be treated as rejected');
 assert.equal(failedUpdates,1,'Ambiguous Stripe failure must preserve refund lock');
 console.log('Refund POST mock tests passed');
}

const order={id:'order_test',stripe_session_id:'cs_test_123',total_pence:2000};
const env={DB,STRIPE_SECRET_KEY:'sk_test_mock',LOYALTY_DB:{prepare(){return {bind(){return {async first(){return null}}}}}}};
(async()=>{
 scenario={refunds:[]};audit.length=0;
 let result=await state(env,order);
 assert.equal(result.refundable_pence,2000);
 assert.equal(result.refunded_pence,0);
 scenario={refunds:[{id:'re_test_1',amount:600,status:'succeeded',reason:'requested_by_customer',metadata:{}}]};
 audit.length=0;result=await state(env,order);
 assert.equal(result.refunded_pence,600);
 assert.equal(result.refundable_pence,1400);
 scenario={refunds:[{id:'re_test_1',amount:600,status:'pending',reason:'requested_by_customer',metadata:{}}]};
 audit.length=0;result=await state(env,order);
 assert.equal(result.pending_pence,600);
 assert.ok(audit.some(x=>x.sql.includes('WHERE stripe_refund_id=? OR idempotency_key=?')&&x.args[1]==='pending'&&x.args[2]==='re_test_1'),'External refund must update to pending by ID');
 scenario={refunds:[{id:'re_test_1',amount:600,status:'succeeded',reason:'requested_by_customer',metadata:{}}]};
 audit.length=0;result=await state(env,order);
 assert.equal(result.refunded_pence,600);
 assert.ok(audit.some(x=>x.sql.includes('WHERE stripe_refund_id=? OR idempotency_key=?')&&x.args[1]==='succeeded'&&x.args[2]==='re_test_1'),'External refund must update to succeeded by ID');
 assert.ok(audit.some(x=>x.sql.includes('INSERT OR IGNORE INTO order_refunds')),'External Stripe refund must be recorded');
 assert.ok(audit.some(x=>x.sql.includes('WHERE stripe_refund_id=? OR idempotency_key=?')&&x.args[2]==='re_test_1'),'External refund status must reconcile by Stripe refund ID');
 scenario={refunds:[{id:'re_test_2',amount:700,status:'pending',metadata:{}}]};
 result=await state(env,order);
 assert.equal(result.pending_pence,700);
 assert.equal(result.refundable_pence,1300);
 scenario={refunds:[{id:'re_pending_1',amount:100,status:'pending',metadata:{}},{id:'re_pending_2',amount:100,status:'pending',metadata:{}}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/Multiple pending Stripe refunds/);
 assert.equal(audit.length,0,'Multiple pending refunds must not partially modify the ledger');
 scenario={refunds:[{id:'re_duplicate',amount:100,status:'succeeded',metadata:{}},{id:'re_duplicate',amount:100,status:'succeeded',metadata:{}}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/Invalid or duplicate Stripe refund data/);
 assert.equal(audit.length,0,'Duplicate Stripe refund records must not modify ledger');
 scenario={refunds:[{id:'re_invalid',amount:-1,status:'succeeded',metadata:{}}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/Invalid or duplicate Stripe refund data/);
 assert.equal(audit.length,0,'Invalid Stripe refund amount must not modify ledger');
 scenario={refunds:[],sessionAmount:1999};audit.length=0;
 await assert.rejects(()=>state(env,order),/Order total does not match Stripe payment/);
 assert.equal(audit.length,0,'Payment mismatch must not alter ledger');
 scenario={refunds:[{id:'re_overpaid',amount:2001,status:'succeeded',metadata:{}}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/Stripe refunds exceed the order total/);
 assert.equal(audit.length,0,'Over-refunded Stripe history must not alter ledger');
 scenario={refunds:[{id:'re_unknown',amount:100,status:'mystery',metadata:{}}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/Unknown Stripe refund status/);
 assert.equal(audit.length,0,'Unknown refund state must not alter ledger');
 scenario={refunds:[],paymentStatus:'unpaid'};audit.length=0;
 await assert.rejects(()=>state(env,order),/not a completed GBP payment/);
 assert.equal(audit.length,0);
 scenario={refunds:[],sessionId:'cs_other'};audit.length=0;
 await assert.rejects(()=>state(env,order),/checkout session mismatch/);
 assert.equal(audit.length,0);
 scenario={refunds:[],sessionCurrency:'usd'};audit.length=0;
 await assert.rejects(()=>state(env,order),/not a completed GBP payment/);
 assert.equal(audit.length,0);
 scenario={refunds:[{id:'re_other',amount:100,status:'succeeded',payment_intent:'pi_other'}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/does not match the GBP payment/);
 assert.equal(audit.length,0);
 scenario={refunds:[{id:'re_currency',amount:100,status:'succeeded',currency:'usd'}]};audit.length=0;
 await assert.rejects(()=>state(env,order),/does not match the GBP payment/);
 assert.equal(audit.length,0);
 scenario={refunds:[],has_more:true};
 await assert.rejects(()=>state(env,order),/Refund history too large/);
 console.log('Refund reconciliation mock tests passed');
 await checkPost();
 require('node:child_process').execFileSync(process.execPath,['scripts/test-loyalty-refunds.cjs'],{stdio:'inherit'});
})().catch(e=>{console.error(e);process.exitCode=1});
