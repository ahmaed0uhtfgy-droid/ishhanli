// تتبّع الفلوس للعميل: بيحوّل حالة الطلب + escrowStatus لـ 3 مراحل واضحة (دالة نقية — بتتختبر من غير متصفح)
const PAID = ['payment_review', 'paid', 'heading_pickup', 'picked_up', 'in_transit', 'delivered', 'completed', 'resolved', 'disputed'];
const OUT = ['released', 'settled', 'refund_pending', 'refunded'];

/** @returns {null | Array<{key:string, state:'done'|'now'|'wait', text:string}>} null = مفيش فلوس تتعرض (لسه ما اتدفعش) */
export function moneySteps(o) {
  const esc = o?.escrowStatus || '';
  const paid = PAID.includes(o?.status) || ['held', ...OUT].includes(esc);
  if (!paid) return null;
  const underReview = o.status === 'payment_review' && esc !== 'held';
  const out = OUT.includes(esc) ? esc : '';
  const heldNow = esc === 'held';
  return [
    { key: 'paid', state: underReview ? 'now' : 'done', text: underReview ? 'money.paid.review' : 'money.paid.done' },
    { key: 'held', state: heldNow ? 'now' : (underReview ? 'wait' : 'done'), text: heldNow || underReview ? 'money.held.done' : 'money.held.past' },
    { key: 'out', state: out ? 'done' : 'wait',
      text: out === 'released' || out === 'settled' ? 'money.out.released' : out ? 'money.out.' + out : o.status === 'disputed' ? 'money.out.disputed' : 'money.out.wait' },
  ];
}
