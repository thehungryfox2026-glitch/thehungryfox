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
const catalogText=html.slice(html.indexOf('const HUNGRY_FOX_PRODUCTS = [')+'const HUNGRY_FOX_PRODUCTS = '.length);
const products=Function('const HUNGRY_FOX_PRODUCTS = '+catalogText.slice(0,catalogText.indexOf('const DESSERT_OPTIONS'))+';return HUNGRY_FOX_PRODUCTS')().map(p=>({id:p.Product_ID,name:p.Product_Name,category:p.Category,price:p.Price}));
test('every product belongs to one of the nine visible menu categories',()=>{
 const categories=constant('CATEGORY_ORDER');
 assert.equal(categories.length,9);
 assert.equal(new Set(categories).size,9);
 assert.equal(products.length, 118);
 for(const p of products){
  const order=constant('MENU_ITEM_ORDER');
  assert.equal(categories.filter(c=>order[c].includes(p.id)).length,1,p.id+' must appear in exactly one visible category');
  assert.ok(Number.isFinite(p.price)&&p.price>=0,p.id+' invalid price');
 }
});
test('all twelve customer-facing chicken flavours are present once and Plain is first',()=>{
 const flavours=constant('CHICKEN_FLAVOURS');
 assert.equal(flavours.length,12);
 assert.equal(new Set(flavours).size,12);
 assert.equal(flavours[0],'Plain');
 for(const flavour of ['Garlic Parmesan','Sticky BBQ','Peri Peri','Buffalo','Honey Sriracha','Smoky Cajun','Spicy Algerian','Mango Habanero','Naga','Volcano','Spicy BBQ']){
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

test('drizzle mirrors active flavours and retired Hot Hot is absent',()=>{
 const CHICKEN_FLAVOURS=constant('CHICKEN_FLAVOURS');
 const expression=html.match(/const DRIZZLE_OPTIONS = ([^;]+);/)[1];
 const drizzle=Function('CHICKEN_FLAVOURS','return ('+expression+')')(CHICKEN_FLAVOURS);
 assert.deepEqual(drizzle,['No Drizzle',...CHICKEN_FLAVOURS.filter(x=>x!=='Plain')]);
 assert.ok(CHICKEN_FLAVOURS.includes('Naga Sauce (Extra Hot)'));
 assert.ok(!/Hot Hot/i.test(html));
});
