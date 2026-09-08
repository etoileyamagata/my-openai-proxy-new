const assert = require('assert');
const handler = require('../api/ebay-market-core.js');
const t = handler;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('marketFacts removes generated description/keywords and keeps objective facts', () => {
  const facts = t.marketFacts({
    categoryId: '31387', brandEnglish: 'Rolex', modelNumber: '16233', dialColor: 'ブラック',
    aiDescriptionJa: 'generated', aiKeywordsJa: 'generated keywords'
  });
  assert.strictEqual(facts.modelNumber, '16233');
  assert.strictEqual(facts.dialColor, 'ブラック');
  assert.ok(!Object.prototype.hasOwnProperty.call(facts, 'aiDescriptionJa'));
  assert.ok(!Object.prototype.hasOwnProperty.call(facts, 'aiKeywordsJa'));
});

test('marketFacts rejects serial/date code matching keys', () => {
  assert.throws(() => t.marketFacts({ serialNumber: 'ABC', categoryId: '1', brandEnglish: 'X' }), /forbidden/);
});

test('modelStatus accepts model in title when structured field is missing', () => {
  assert.strictEqual(t.modelStatus('', '1990 Rolex Datejust 16233 36mm Black Dial', '16233'), 'confirmed');
});

test('black dial matches black and rejects silver', () => {
  assert.strictEqual(t.colorStatus('Black', 'ブラック', true), 'confirmed');
  assert.strictEqual(t.colorStatus('Silver', 'ブラック', true), 'mismatch');
});

test('champagne accepts explicit gold dial aliases', () => {
  assert.strictEqual(t.colorStatus('Gold Tone', 'シャンパン', true), 'confirmed');
  assert.strictEqual(t.colorStatus('Blue', 'シャンパン', true), 'mismatch');
});

test('purity aliases K18/18K/750 are equivalent', () => {
  assert.strictEqual(t.purityStatus('750', 'K18'), 'confirmed');
  assert.strictEqual(t.purityStatus('14K', 'K18'), 'mismatch');
});

test('material explicit mismatch is rejected', () => {
  assert.strictEqual(t.materialStatus('Leather', 'キャンバス'), 'mismatch');
  assert.strictEqual(t.materialStatus('Stainless Steel', 'ステンレス'), 'confirmed');
});

test('rankCandidates prefers source-backed but retains valid output-only candidates', () => {
  const a = 'https://www.ebay.com/itm/127855750145';
  const b = 'https://www.ebay.com/itm/186800234993';
  const ranked = t.rankCandidates([b, a], [a]);
  assert.deepStrictEqual(ranked, [a, b]);
});

test('exact USD sold body-only with box becomes support price', () => {
  const evidence = t.priceEvidence({
    soldStatusConfirmed: true,
    exactSoldPriceUsd: 7000,
    priceEvidenceType: 'exact_usd_sold',
    hasBox: true,
    hasPapers: false
  }, { accessories: '本体のみ' });
  assert.strictEqual(evidence.exactPrice, 0);
  assert.strictEqual(evidence.supportPrice, 7000);
  assert.strictEqual(evidence.supportType, 'accessory_upper');
});

test('best offer ask is support only', () => {
  const evidence = t.priceEvidence({
    soldStatusConfirmed: true,
    displayedUpperBoundUsd: 7000,
    priceEvidenceType: 'best_offer_upper',
    bestOfferAccepted: true
  }, { accessories: '本体のみ' });
  assert.strictEqual(evidence.exactPrice, 0);
  assert.strictEqual(evidence.supportPrice, 7000);
});

test('derivePricing uses server-side exact sold prices, not model pricing', () => {
  const result = t.derivePricing([
    { exactPrice: 5200, supportPrice: 0 },
    { exactPrice: 6000, supportPrice: 0 },
    { exactPrice: 7000, supportPrice: 0 }
  ]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.pricing, { quickUsd: 5600, targetUsd: 6000, highUsd: 6500 });
});

test('derivePricing permits one exact plus one support, but not support-only', () => {
  const oneExact = t.derivePricing([
    { exactPrice: 5200, supportPrice: 0 },
    { exactPrice: 0, supportPrice: 6000 }
  ]);
  assert.strictEqual(oneExact.ok, true);
  assert.strictEqual(oneExact.pricing.targetUsd, 5200);
  const noExact = t.derivePricing([
    { exactPrice: 0, supportPrice: 6000 },
    { exactPrice: 0, supportPrice: 6500 }
  ]);
  assert.strictEqual(noExact.ok, false);
});

test('watch comparable rejects explicit wrong dial but keeps unknown dial for review', () => {
  const facts = { kind: 'watch', modelNumber: '16233', caseSize: '36', dialColor: 'ブラック', accessories: '本体のみ' };
  const wrong = t.assessComparable({
    url: 'https://www.ebay.com/itm/800273545789', title: 'Rolex Datejust 16233 36mm', soldStatusConfirmed: true,
    modelNumber: '16233', caseSizeMm: 36, dialColor: 'Silver', priceEvidenceType: 'exact_usd_sold', exactSoldPriceUsd: 6000,
    condition: 'Pre-owned - Good'
  }, facts);
  assert.strictEqual(wrong.reviewEligible, false);
  const unknown = t.assessComparable({
    url: 'https://www.ebay.com/itm/800273545780', title: 'Rolex Datejust 16233 36mm', soldStatusConfirmed: true,
    modelNumber: '16233', caseSizeMm: 36, dialColor: '', priceEvidenceType: 'exact_usd_sold', exactSoldPriceUsd: 6000,
    condition: 'Pre-owned - Good'
  }, facts);
  assert.strictEqual(unknown.reviewEligible, true);
  assert.strictEqual(unknown.pricingEligible, false);
});

test('generic jewelry comparable enforces purity and material when known', () => {
  const facts = { kind: 'jewelry', brandEnglish: 'BVLGARI', material: 'K18WG', purity: 'K18', color: '' };
  const good = t.assessComparable({
    url: 'https://www.ebay.com/itm/123456789012', title: 'BVLGARI ring 18K white gold', soldStatusConfirmed: true,
    material: 'White Gold', purity: '750', priceEvidenceType: 'exact_usd_sold', exactSoldPriceUsd: 1000,
    condition: 'Pre-owned - Good'
  }, facts);
  assert.strictEqual(good.reviewEligible, true);
  assert.strictEqual(good.pricingEligible, true);
  const bad = t.assessComparable({
    url: 'https://www.ebay.com/itm/123456789013', title: 'BVLGARI ring silver', soldStatusConfirmed: true,
    material: 'Silver', purity: '925', priceEvidenceType: 'exact_usd_sold', exactSoldPriceUsd: 500,
    condition: 'Pre-owned - Good'
  }, facts);
  assert.strictEqual(bad.reviewEligible, false);
});

test('multi-material target requires every stated material group', () => {
  assert.strictEqual(t.materialStatus('Stainless Steel, Yellow Gold', 'ステンレススチール イエローゴールド'), 'confirmed');
  assert.strictEqual(t.materialStatus('Stainless Steel', 'ステンレススチール イエローゴールド'), 'mismatch');
});

test('platinum purity does not get mistaken for gold 999', () => {
  assert.strictEqual(t.purityStatus('Pt999', 'Pt1000'), 'confirmed');
  assert.strictEqual(t.purityStatus('999.9', 'K24'), 'confirmed');
  assert.strictEqual(t.purityStatus('Pt950', 'K24'), 'mismatch');
});

test('used Good and used Excellent are same broad condition group, new is mismatch', () => {
  assert.strictEqual(t.conditionStatus('Pre-owned - Good', 'Pre-owned - Excellent'), 'confirmed');
  assert.strictEqual(t.conditionStatus('New with tags', 'Pre-owned - Excellent'), 'mismatch');
});

test('no-model generic item requires verifier identity confirmation for pricing', () => {
  const facts = { kind: 'bag', brandEnglish: 'Coach', verifiedProductNameEnglish: 'Tyler Carryall', color: 'Black', conditionName: 'Pre-owned - Excellent' };
  const uncertain = t.assessComparable({
    url: 'https://www.ebay.com/itm/123456789014', title: 'Coach tote bag black', soldStatusConfirmed: true,
    color: 'Black', identityMatchStatus: 'unconfirmed', priceEvidenceType: 'exact_usd_sold', exactSoldPriceUsd: 150,
    condition: 'Pre-owned - Good'
  }, facts);
  assert.strictEqual(uncertain.reviewEligible, true);
  assert.strictEqual(uncertain.pricingEligible, false);
  const confirmed = t.assessComparable({
    url: 'https://www.ebay.com/itm/123456789015', title: 'Coach Tyler Carryall black', soldStatusConfirmed: true,
    color: 'Black', identityMatchStatus: 'confirmed', priceEvidenceType: 'exact_usd_sold', exactSoldPriceUsd: 180,
    condition: 'Pre-owned - Good'
  }, facts);
  assert.strictEqual(confirmed.pricingEligible, true);
});

test('review comparable exposes legacy soldPriceUsd and similarityReason fields for AILIS compatibility', () => {
  const item = t.assessComparable({
    url: 'https://www.ebay.com/itm/123456789016', title: 'Rolex Datejust 16233 36mm Black Dial', soldStatusConfirmed: true,
    modelNumber: '16233', caseSizeMm: 36, dialColor: 'Black', exactSoldPriceUsd: 5200,
    priceEvidenceType: 'exact_usd_sold', condition: 'Pre-owned - Good', verificationReasonJa: 'verified'
  }, { kind: 'watch', modelNumber: '16233', caseSize: '36', dialColor: 'ブラック', conditionName: 'Pre-owned - Excellent' });
  assert.strictEqual(item.soldPriceUsd, 5200);
  assert.strictEqual(item.similarityReason, 'verified');
});

test('manual result keeps matching sold URLs even when pricing cannot be automated', () => {
  const facts = { kind: 'watch', modelNumber: '16233', caseSize: '36', dialColor: 'ブラック', conditionName: 'Pre-owned - Excellent' };
  const assessed = [
    t.assessComparable({
      url: 'https://www.ebay.com/itm/127855750145', title: 'Rolex Datejust 16233 36mm Black Dial', soldStatusConfirmed: true,
      modelNumber: '16233', caseSizeMm: 36, dialColor: 'Black', exactSoldPriceUsd: 5199.99,
      priceEvidenceType: 'exact_usd_sold', condition: 'Pre-owned - Good'
    }, facts),
    t.assessComparable({
      url: 'https://www.ebay.com/itm/800273545789', title: 'Rolex Datejust 16233 36mm', soldStatusConfirmed: true,
      modelNumber: '16233', caseSizeMm: 36, dialColor: '', exactSoldPriceUsd: 6050,
      priceEvidenceType: 'exact_usd_sold', condition: 'Pre-owned - Good'
    }, facts)
  ];
  const result = t.resultFromAssessment(assessed, [], facts);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.soldUrls.length, 2);
});

const prompts = require('../api/ebay-market-prompts.js');
test('black search profile is generic and includes black aliases', () => {
  const profile = prompts.searchProfile({ brandEnglish: 'Rolex', verifiedProductNameEnglish: 'Datejust', modelNumber: '16233', dialColor: 'ブラック', caseSize: '36' });
  assert.ok(profile.some(q => /Black Dial/i.test(q)));
  assert.ok(profile.some(q => /16233/i.test(q)));
});

test('discovery prompt does not exclude candidates merely for containing their own serial/year', () => {
  const prompt = prompts.discoveryPrompt({ brandEnglish: 'Rolex', modelNumber: '16233', dialColor: 'ブラック' });
  assert.ok(prompt.includes('候補出品にその出品固有のシリアル、年式、日付コードが書かれているだけで除外してはいけない'));
});

console.log('All ebay-market tests passed.');
