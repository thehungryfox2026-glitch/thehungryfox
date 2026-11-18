// Run with: node --test tests/checkout-menu.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const index = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const worker = fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
const menuMatch = worker.match(/const MENU=([\s\S]*?);/);
assert.ok(menuMatch,'Backend MENU must exist');
const MENU = Function('return '+menuMatch[1])();
const catalogText = index.slice(index.indexOf('const HUNGRY_FOX_PRODUCTS = [') + 'const HUNGRY_FOX_PRODUCTS = '.length);
const catalog = Function('return '+catalogText.slice(0,catalogText.indexOf('];')+2))();
const products = catalog.map(p=>[null,p.Product_ID,p.Product_Name,p.Category,String(p.Price)]);
const priceFunction = worker.slice(worker.indexOf('function serverOptionPricePence'),worker.indexOf('function hungryFoxOrderingOpen'));
assert.ok(priceFunction.startsWith('function serverOptionPricePence'));
const serverOptionPricePence = Function('MENU',priceFunction+';return serverOptionPricePence')(MENU);
function array(name){
 const match=index.match(new RegExp('const '+name+' = ([\\s\\S]*?);'));
 assert.ok(match,name+' missing');
 return Function('return '+match[1])();
}
test('all menu products exist with exactly matching names and prices',()=>{
 assert.ok(products.length >= 100, 'unexpected loss of customer-facing menu products');
 assert.equal(Object.keys(MENU).length, products.length, 'unexpected change to backend-only menu entries');
 const seen=new Set();
 for(const [,id,name,,price] of products){
  assert.ok(!seen.has(id),'duplicate '+id);seen.add(id);
  assert.deepEqual(MENU[id],[name,Number(price)],id);
 }
});
for(const [name,label] of [['BREAD_OPTIONS','Bread Choice'],['BUNDLE_SIDES','Bundle Side'],['CANNED_DRINKS','Drink 1'],['BOTTLED_DRINKS','Drink 2']]){
 test(name+' matches server-side option prices',()=>{
  for(const option of array(name)){
   const value=typeof option==='string'?option:option.name;
   const expected=typeof option==='string'?0:Math.round(option.price*100);
   assert.equal(serverOptionPricePence('FEA005',{label,value}),expected,value);
  }
 });
}
test('dessert default and all actual desserts pass validation',()=>{
 assert.equal(serverOptionPricePence('FEA005',{label:'Dessert',value:'No Dessert'}),0);
 for(const [id,[name,price]] of Object.entries(MENU).filter(([id])=>id.startsWith('DES'))){
  assert.equal(serverOptionPricePence('FEA005',{label:'Dessert',value:name}),Math.round(price*100),id);
 }
 assert.equal(serverOptionPricePence('FEA005',{label:'Dessert',value:'Invalid dessert'}),null);
});
test('meal upgrades and drink add-ons are validated and correctly priced',()=>{
 assert.equal(serverOptionPricePence('CHK001',{label:'Meal Upgrade',value:'Fries & Drink (+£1.99)'}),199);
 assert.equal(serverOptionPricePence('CHK005',{label:'Whole Chicken Meal Upgrade',value:'2 Fries & Bottled Drink (+£6.50)'}),650);
 assert.equal(serverOptionPricePence('DON001',{label:'Optional Add-on',value:'2 x Drink Can (1 x Coke, 1 x Red Bull)'}),298);
 assert.equal(serverOptionPricePence('DON001',{label:'Optional Add-on',value:'2 x Drink Can (1 x Coke)'}),null);
 assert.equal(serverOptionPricePence('DON001',{label:'Optional Add-on',value:'1 x Drink Can (2 x Coke)'}),null);
 assert.equal(serverOptionPricePence('DON001',{label:'Optional Add-on',value:'1 x Invalid item'}),null);
});
test('no coupon-write dependency and ordering time zone is UK',()=>{
 assert.ok(!worker.includes('api.stripe.com/v1/coupons'));
 assert.ok(worker.includes('timeZone:\'Europe/London\''));
 assert.ok(index.includes('timeZone:\'Europe/London\''));
});

test('unknown checkout option labels are rejected rather than silently free',()=>{
 assert.equal(serverOptionPricePence('CHK001',{label:'Invented free upgrade',value:'Extra chicken'}),null);
 assert.equal(serverOptionPricePence('CHK001',{label:'Flavour 1',value:'Plain'}),0);
 assert.equal(serverOptionPricePence('CHK001',{label:'Seasoning 1',value:'Regular Salt'}),0);
 assert.equal(serverOptionPricePence('CHK001',{label:'Meal Bottled Drink',value:'Bottle Coke'}),0);
});


test('free premium side is restricted to the five new bowls and platters',()=>{
 const premium=['Mozzarella Sticks (6 Pcs)','Onion Rings (8 Pcs)','Halloumi Fries (6 Pcs)','Mini Singara (8 Pcs)','Chilli Cheese Bites (3 Pcs)','Vegetable Samosa (4 Pcs)','Vegetable Spring Roll (4 Pcs)','Veg Bao Buns (2 Pcs)','Prawn Gyoza (3 Pcs)','Chilli Cheese Bites (6 Pcs)','Mac N Cheese Bites (8 Pcs)','Medium Singara (4 Pcs)','Zinger Crisper Strips (6 Pcs)'];
 for(const id of ['BWL001','BWL002','BWL003','BWL004','BWL005']){
  for(const value of premium) assert.equal(serverOptionPricePence(id,{label:'Premium Side',value}),0,id+': '+value);
 }
 for(const id of ['PLT008','PLT004','FEA012','BDL008','FEA001','CHK001']){
  assert.equal(serverOptionPricePence(id,{label:'Premium Side',value:premium[0]}),null,id+' must not receive free side');
 }
 assert.equal(serverOptionPricePence('BWL001',{label:'Premium Side',value:'Invented Side'}),null);
 assert.match(index,/\['BWL001', 'BWL002', 'BWL003', 'BWL004', 'BWL005'\]\.includes\(id\)/);
});


test('only new bowls receive free bread upgrades and four-piece cheese sides',()=>{
 for(const id of ['BWL001','BWL004','BWL005'])for(const value of ['Plain Naan','Plain Pitta Bread','Garlic Naan','Peri Peri Pitta Bread'])assert.equal(serverOptionPricePence(id,{label:'Bread Choice',value}),0);
 assert.equal(serverOptionPricePence('FEA001',{label:'Bread Choice',value:'Garlic Naan'}),99);
 assert.equal(serverOptionPricePence('FEA001',{label:'Bread Choice',value:'Peri Peri Pitta Bread'}),49);
 for(const id of ['BWL001','BWL002','BWL003','BWL004','BWL005'])for(const value of ['Chilli Cheese Bites (4 Pcs)','Mac N Cheese Bites (4 Pcs)'])assert.equal(serverOptionPricePence(id,{label:'Premium Side',value}),0);
 assert.equal(serverOptionPricePence('PLT008',{label:'Premium Side',value:'Mac N Cheese Bites (4 Pcs)'}),null);
 assert.equal(serverOptionPricePence('PLT008',{label:'Included Dips',value:'1 x Hot Chilli'}),0);
 assert.match(index,/Hot Chilli/);
});
