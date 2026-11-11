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
 if(url.includes('/checkout/sessions/'))return {ok:true,json:async()=>({payment_intent:'pi_test_123'})};
 if(url.includes('/refunds?'))return {ok:true,json:async()=>({data:scenario.refunds,has_more:!!scenario.has_more})};
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
 response=await postRefund(request({amount_pence:2001,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,409);
 response=await postRefund(request({amount_pence:-1,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,400);
 env.LOYALTY_DB.prepare=()=>({bind:()=>({first:async()=>({id:'loyalty_test'})})});
 response=await postRefund(request({amount_pence:500,reason:'requested_by_customer'}),env,'order_test');
 assert.equal(response.status,409);
 assert.equal(inserted,1,'Loyalty-linked refund must not reach Stripe');
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
const env={DB,STRIPE_SECRET_KEY:'sk_test_mock'};
(async()=>{
 scenario={refunds:[]};audit.length=0;
 let result=await state(env,order);
 assert.equal(result.refundable_pence,2000);
 assert.equal(result.refunded_pence,0);
 scenario={refunds:[{id:'re_test_1',amount:600,status:'succeeded',reason:'requested_by_customer',metadata:{}}]};
 audit.length=0;result=await state(env,order);
 assert.equal(result.refunded_pence,600);
 assert.equal(result.refundable_pence,1400);
 assert.ok(audit.some(x=>x.sql.includes('INSERT OR IGNORE INTO order_refunds')),'External Stripe refund must be recorded');
 assert.ok(audit.some(x=>x.sql.includes('WHERE stripe_refund_id=? OR idempotency_key=?')&&x.args[2]==='re_test_1'),'External refund status must reconcile by Stripe refund ID');
 scenario={refunds:[{id:'re_test_2',amount:700,status:'pending',metadata:{}}]};
 result=await state(env,order);
 assert.equal(result.pending_pence,700);
 assert.equal(result.refundable_pence,1300);
 scenario={refunds:[],has_more:true};
 await assert.rejects(()=>state(env,order),/Refund history too large/);
 console.log('Refund reconciliation mock tests passed');
 await checkPost();
})().catch(e=>{console.error(e);process.exitCode=1});
