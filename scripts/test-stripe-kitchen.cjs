const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
let code=fs.readFileSync('worker.js','utf8');
code=code.replace('export default{async fetch(req,env)','globalThis.worker={async fetch(req,env)');
const context={Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder,crypto,atob,btoa,console,fetch:async()=>{throw Error('Unexpected network call')}};
vm.createContext(context);vm.runInContext(code,context);
const saved=[],items=[];
function statement(sql,args=[]){return{bind(...values){return statement(sql,values)},async first(){if(sql.includes('SELECT id FROM orders'))return saved.find(o=>o.stripe_session_id===args[0])||null;throw Error('Unexpected first '+sql)},async run(){if(sql.startsWith('INSERT OR IGNORE INTO orders')){if(saved.some(o=>o.stripe_session_id===args[1]))return{meta:{changes:0}};saved.push({id:args[0],stripe_session_id:args[1],reference:args[2]});return{meta:{changes:1}}}if(sql.startsWith('INSERT INTO order_items')){if(saved.some(o=>o.id===args[5]))items.push({name:args[1],quantity:args[2]});return{meta:{changes:1}}}throw Error('Unexpected run '+sql)}}}
const env={DB:{prepare:sql=>statement(sql),async batch(stmts){for(const s of stmts)await s.run()}},STRIPE_SECRET_KEY:'mock-secret'};
context.fetch=async(url,opts)=>{assert.match(url,/\/line_items\?limit=100$/);assert.equal(opts.headers.Authorization,'Bearer mock-secret');return new Response(JSON.stringify({has_more:false,data:[{description:'Baked Wings (6 Pcs)',quantity:2,amount_subtotal:1398},{description:'Delivery and minimum-order adjustment',quantity:1,amount_total:199}]}),{status:200})};
(async()=>{const session={id:'cs_live_fake_test_12345678',metadata:{order_source:'website',customer_name:'Test',delivery_address:'Test address',postcode:'RM17 1AA'},amount_total:1597,customer_details:{email:'test@example.invalid'}};
await context.savePaidKitchenOrder(session,env);
assert.equal(saved.length,1);assert.equal(items.length,1);assert.equal(items[0].quantity,2);
await context.savePaidKitchenOrder(session,env);
assert.equal(saved.length,1);assert.equal(items.length,1);
await context.savePaidKitchenOrder({...session,id:'cs_live_other',metadata:{order_source:'other'}},env);
assert.equal(saved.length,1);
console.log('Mock Stripe paid-order storage and retry tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
