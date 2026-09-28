import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFromId } from '../src/cards.js';
import { canPlaceOnLayout, emptyLayout, legalLayoutCards, legalTrickCards, trickWinner } from '../src/rules.js';
import type { Layout, PlayedCard, Position } from '../src/types.js';

const cards = (s: string) => s.split(' ').map(cardFromId);
const trick = (s: string): PlayedCard[] => cards(s).map((card, i) => ({ player: i as Position, card }));
const ids = (cs: { id: string }[]) => cs.map(c => c.id).sort();

test('štih: mora se pratiti boja', () => {
  assert.deepEqual(ids(legalTrickCards(cards('7S AS 9H'), trick('10S'))), ['7S', 'AS']);
});

test('štih: bez boje — bilo koja karta', () => {
  assert.deepEqual(ids(legalTrickCards(cards('7D 9H'), trick('10S'))), ['7D', '9H']);
});

test('štih: prvi igrač igra bilo šta', () => {
  assert.equal(legalTrickCards(cards('7D 9H'), []).length, 2);
});

test('štih nosi najjača karta u boji koja je prva odigrana (nema aduta)', () => {
  assert.equal(trickWinner(trick('9S AH 10S 7S')).player, 2);
  assert.equal(trickWinner(trick('7C AD AH AS')).player, 0);
});

function layout(start: string, piles: Partial<Record<'S' | 'H' | 'D' | 'C', string>>): Layout {
  const l = emptyLayout();
  l.startRank = start as Layout['startRank'];
  const map = { S: '♠', H: '♥', D: '♦', C: '♣' } as const;
  for (const [k, v] of Object.entries(piles)) l.piles[map[k as 'S']] = v!.split(' ') as never;
  return l;
}

test('lora: prva karta može bilo koja', () => {
  assert.ok(canPlaceOnLayout(emptyLayout(), cardFromId('JD')));
});

test('lora: nova boja se otvara početnim rangom', () => {
  const l = layout('9', { S: '9' });
  assert.ok(canPlaceOnLayout(l, cardFromId('9H')));
  assert.ok(!canPlaceOnLayout(l, cardFromId('10H')));
});

test('lora: boja se nastavlja sledećim rangom; posle keca ide sedmica', () => {
  const l = layout('9', { S: '9 10 J Q K A' });
  assert.ok(canPlaceOnLayout(l, cardFromId('7S')));
  assert.ok(!canPlaceOnLayout(l, cardFromId('8S')));
  const full = layout('9', { S: '9 10 J Q K A 7 8' });
  assert.ok(!canPlaceOnLayout(full, cardFromId('9S')));
});

test('lora: legalne karte iz ruke', () => {
  const l = layout('J', { H: 'J Q' });
  assert.deepEqual(ids(legalLayoutCards(cards('KH JS 7C AH'), l)), ['JS', 'KH']);
});
