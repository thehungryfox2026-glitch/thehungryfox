const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=fs.readFileSync('worker.js','utf8').replace('export default{async fetch(req,env)','globalThis.worker={async fetch(req,env)');
const context={Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder,crypto,fetch:async()=>{throw Error('Unexpected network request')},atob,btoa,console,setInterval:()=>{}};
vm.createContext(context);vm.runInContext(code,context);
const worker=context.worker;
const orders=[{id:'123e4567-e89b-12d3-a456-426614174000',order_reference:'ABC12345',customer_name:'Test Customer',payment_status:'paid',kitchen_status:'NEW',total_pence:2499}];
const db={prepare(sql){return{bind(...args){return{async run(){if(sql.startsWith('UPDATE orders')){orders[0].kitchen_status=args[0];return{meta:{changes:1}}}throw Error('Unexpected SQL run')},async all(){if(sql.includes('order_items'))return{results:[{product_name:'6 Wings',quantity:1,unit_price_pence:699,options:'BBQ'}]};throw Error('Unexpected SQL all')},async first(){throw Error('Unexpected SQL first')}}},async all(){if(sql.startsWith('SELECT * FROM orders'))return{results:orders};throw Error('Unexpected SQL')}}}};
const env={DASHBOARD_PASSWORD:'test-password',DB:db};
async function get(path,headers={}){return worker.fetch(new Request('https://example.test'+path,{headers}),env)}
(async()=>{
 let r=await get('/kitchen');assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');
 r=await get('/kitchen/api/orders');assert.equal(r.status,401);
 const auth={Authorization:'Basic '+btoa('staff:test-password')};
 r=await get('/kitchen',auth);assert.equal(r.status,200);assert.match(await r.text(),/Kitchen Orders/);
 r=await get('/kitchen/api/orders',auth);assert.equal(r.status,200);const data=await r.json();assert.equal(data.orders[0].items[0].product_name,'6 Wings');
 r=await worker.fetch(new Request('https://example.test/kitchen/api/orders/'+orders[0].id+'/status',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({status:'PREPARING'})}),env);assert.equal(r.status,200);assert.equal(orders[0].kitchen_status,'PREPARING');
 r=await worker.fetch(new Request('https://example.test/kitchen/api/orders/'+orders[0].id+'/status',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({status:'INVALID'})}),env);assert.equal(r.status,400);
 r=await worker.fetch(new Request('https://example.test/kitchen/api/orders',{method:'OPTIONS'}),env);assert.equal(r.status,405);
 console.log('Kitchen functional route tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
