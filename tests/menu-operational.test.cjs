// Operational menu invariants: run with node --test tests/*.test.cjs
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const worker=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
function constant(name){
 const match=html.match(new RegExp('const '+name+' = ([\\s\\S]*?);'));
 assert.ok(match,'Missing menu constant: '+name);
 return Function('return ('+match[1]+')')();
}
const products=[...html.matchAll(/\{\s*Product_ID: '([A-Z]{2,4}\d{3})', Product_Name: '([^']+)', Category: '([^']+)', Price: ([\d.]+)/g)]
 .map(m=>({id:m[1],name:m[2],category:m[3],price:Number(m[4])}));
test('every product belongs to one of the twelve visible menu categories',()=>{
 const categories=constant('CATEGORY_ORDER');
 assert.equal(categories.length,12);
 assert.equal(new Set(categories).size,12);
 assert.equal(products.length,100);
 for(const p of products){
  assert.ok(categories.includes(p.category),p.id+' unknown category '+p.category);
  assert.ok(Number.isFinite(p.price)&&p.price>=0,p.id+' invalid price');
 }
});
test('all fourteen customer-facing chicken flavours are present once and Plain is first',()=>{
 const flavours=constant('CHICKEN_FLAVOURS');
 assert.equal(flavours.length,14);
 assert.equal(new Set(flavours).size,14);
 assert.equal(flavours[0],'Plain');
 for(const flavour of ['Garlic Parmesan','Sticky BBQ','Peri Peri','Buffalo','Honey Sriracha','Smoky Cajun','Spicy Algerian','Mango Habanero','Naga','Volcano','Spicy BBQ','Hot Hot','Seoul Fire']){
  assert.equal(flavours.filter(x=>x.split(' (')[0].includes(flavour)).length,1,flavour);
 }
});
test('kids drink choices do not contain generic Fruit Shoot or fizzy drinks',()=>{
 const drinks=constant('KIDS_DRINKS');
 assert.ok(drinks.length>=3);
 for(const drink of drinks){
  const name=typeof drink==='string'?drink:drink.name;
  assert.ok(/water|orange fruit shoot|blackcurrant fruit shoot/i.test(name),'Unexpected kids drink: '+name);
 }
});
test('delivery-only menu has no collection fulfillment option',()=>{
 assert.ok(/delivery/i.test(html));
 assert.ok(!/['"]Collection['"]\s*[,\]]/i.test(html),'Collection appears as a selectable option');
});
test('checkout continues to validate prices on server and use UK timezone',()=>{
 assert.ok(worker.includes('function serverOptionPricePence'));
 assert.ok(worker.includes("timeZone:'Europe/London'"));
});
