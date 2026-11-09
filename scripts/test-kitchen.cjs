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
 const receipt=(await get('/kitchen',auth));const page=await receipt.text();const start=page.indexOf('<script>'),end=page.indexOf('</script>',start);const match=start>=0&&end>start?[null,page.slice(start+8,end)]:null;assert.ok(match,'Kitchen receipt JavaScript should exist');
 const source=match[1];const money=n=>'£'+(Number(n||0)/100).toFixed(2);
 function breakdown(itemPrices,deliveryAdjustment,total){const itemsSubtotal=itemPrices.reduce((a,b)=>a+b,0);const adjustment=deliveryAdjustment;const smallOrderFee=itemsSubtotal>0&&itemsSubtotal<1500&&adjustment>=400?400:0;const deliveryFee=adjustment-smallOrderFee;const discount=itemsSubtotal+adjustment-total;return {itemsSubtotal,deliveryFee,smallOrderFee,discount,total};}
 assert.deepEqual(breakdown([699,799],199,1697),{itemsSubtotal:1498,deliveryFee:199,smallOrderFee:0,discount:0,total:1697});
 assert.deepEqual(breakdown([699],599,1298),{itemsSubtotal:699,deliveryFee:199,smallOrderFee:400,discount:0,total:1298});
 assert.deepEqual(breakdown([2000,1000],0,3000),{itemsSubtotal:3000,deliveryFee:0,smallOrderFee:0,discount:0,total:3000});
 assert.deepEqual(breakdown([1500,1500],399,2899),{itemsSubtotal:3000,deliveryFee:399,smallOrderFee:0,discount:500,total:2899});
 assert.ok(source.includes("Small-order fee: "),'Receipt should show small-order fee separately');
 assert.ok(source.includes("Discount: -"),'Receipt should show a discount when applicable');
 assert.ok(source.includes("TOTAL PAID: "),'Receipt should show total paid');
 console.log('Kitchen functional route tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
