// Run with: node --test tests/checkout-sessions.test.cjs
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const index=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const worker=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
const menuCode=worker.slice(worker.indexOf('const MENU='),worker.indexOf('};',worker.indexOf('const MENU='))+2);
const MENU=Function(menuCode+';return MENU')();
const validator=worker.slice(worker.indexOf('function serverOptionPricePence'),worker.indexOf('function hungryFoxOrderingOpen'));
const checkout=worker.slice(worker.indexOf('async function create(req,env,o)'),worker.indexOf('async function verify(raw,sig,secret)'));
const ids=[...index.matchAll(/Product_ID: '([A-Z]{2,4}\d{3})'/g)].map(m=>m[1]);
const calls=[];
const create=Function('out','quote','hungryFoxOrderingOpen','fetch','splitReceiptOptions','URLSearchParams',
  menuCode+';'+validator+';'+checkout+';return create;')(
  (data,status)=>({data,status}),
  async()=>({available:true,zone:'Grays',totalDeliveryAndSurcharge:0}),
  ()=>true,
  async(url,init)=>{calls.push({url,form:init.body});return{ok:true,json:async()=>({id:'mock_session',url:'https://checkout.stripe.com/mock'})};},
  value=>value?[value]:[],
  URLSearchParams
);
async function checkoutBasket(items){
 const req={json:async()=>({customer:{name:'Test',phone:'07000000000',email:'test@example.com',postcode:'RM17 6QJ',address:'Test address'},items}),headers:{get:()=>null}};
 const result=await create(req,{STRIPE_SECRET_KEY:'mock'},{});
 return {result,form:calls.at(-1)?.form};
}
test('all 100 menu products can create a mocked Stripe checkout session',async()=>{
 assert.equal(ids.length,100);
 for(const id of ids){
  const {result}=await checkoutBasket([{productId:id,quantity:1,options:[]}]);
  assert.equal(result.status,200,id+': '+JSON.stringify(result.data));
 }
});
test('1000 varied baskets reach mocked Stripe with exact discounted totals',async()=>{
 for(let i=0;i<1000;i++){
  const id=ids[i%ids.length],quantity=1+i%4;
  const options=i%3===0?[{label:'Dessert',value:'No Dessert'}]:i%3===1?[{label:'Bread Choice',value:'Garlic Naan'}]:[{label:'Drink 1',value:'Red Bull'}];
  const {result,form}=await checkoutBasket([{productId:id,quantity,options}]);
  assert.equal(result.status,200,id+': '+JSON.stringify(result.data));
  const unit=Math.round(MENU[id][1]*100)+(i%3===1?99:i%3===2?100:0);
  const subtotal=unit*quantity,percent=subtotal>=3000?15:subtotal>=2000?10:0;
  const expected=subtotal-Math.round(subtotal*percent/100);
  let total=0;
  for(const [key,value] of form.entries()){
   const match=key.match(/^line_items\[(\d+)\]\[price_data\]\[unit_amount\]$/);
   if(match)total+=Number(value)*Number(form.get('line_items['+match[1]+'][quantity]'));
  }
  assert.equal(total,expected,id+' '+i);
 }
});
test('invalid paid options fail before Stripe is contacted',async()=>{
 const before=calls.length;
 const {result}=await checkoutBasket([{productId:'DON001',quantity:1,options:[{label:'Optional Add-on',value:'2 x Drink Can (1 x Coke)'}]}]);
 assert.equal(result.status,400);
 assert.equal(calls.length,before);
});
