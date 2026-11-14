// Run with: node --test tests/checkout-menu.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const index = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const worker = fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
const menuMatch = worker.match(/const MENU=([\\s\\S]*?);/);
assert.ok(menuMatch,'Backend MENU must exist');
const MENU = Function('return '+menuMatch[1])();
const products = [...index.matchAll(/\\{\\s*Product_ID: '([A-Z]{2,4}\\d{3})', Product_Name: '([^']+)', Category: '([^']+)', Price: ([\\d.]+)/g)];
const priceFunction = worker.slice(worker.indexOf('function serverOptionPricePence'),worker.indexOf('function hungryFoxOrderingOpen'));
assert.ok(priceFunction.startsWith('function serverOptionPricePence'));
const serverOptionPricePence = Function('MENU',priceFunction+';return serverOptionPricePence')(MENU);
function array(name){
 const match=index.match(new RegExp('const '+name+' = ([\\s\\S]*?);'));
 assert.ok(match,name+' missing');
 return Function('return '+match[1])();
}
test('all menu products exist with exactly matching names and prices',()=>{
 assert.equal(products.length,100);
 assert.equal(Object.keys(MENU).length,100);
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
