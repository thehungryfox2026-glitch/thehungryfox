'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=fs.readFileSync('worker.js','utf8');
const start=code.indexOf('async function reconcileFullRefundLoyalty(');
const end=code.indexOf('async function kitchenRefundDetails(',start);
assert.ok(start>=0&&end>start);
const ctx=vm.createContext({Error});
vm.runInContext(code.slice(start,end),ctx);
const reconcile=vm.runInContext('reconcileFullRefundLoyalty',ctx);
const order={stripe_session_id:'cs_test_example',total_pence:2899};
(async()=>{
 let batches=0,refundedAt=null;
 const env={LOYALTY_DB:{
  prepare(sql){
   return {bind(...args){
    return {sql,args,async first(){return {id:'lo_1',customer_id:'cu_1',refunded_at:refundedAt}}};
   }};
  },
  async batch(stmts){
   batches++;
   assert.equal(stmts.length,5);
   assert.match(stmts[0].sql,/UPDATE loyalty_orders SET refunded_at/);
   assert.match(stmts[1].sql,/refunded_at IS NULL/);
   assert.match(stmts[2].sql,/DELETE FROM loyalty_reward_reservations/);
   assert.match(stmts[3].sql,/DELETE FROM loyalty_rewards/);
   assert.match(stmts[4].sql,/loyalty_refund_reviews/);
   refundedAt='2026-11-11';
  }
 }};
 await reconcile(env,order,100);
 assert.equal(batches,0,'Partial refund must not change loyalty');
 await reconcile(env,order,2899);
 assert.equal(batches,1,'Full refund must reconcile');
 await reconcile(env,order,2899);
 assert.equal(batches,1,'Reconciliation must be idempotent');
 console.log('Full-refund loyalty reconciliation mock tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
