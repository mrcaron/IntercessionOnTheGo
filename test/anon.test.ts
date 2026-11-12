import { describe, expect, it } from 'vitest';
import { AnonRegistry, type AnonStore } from '../src/dash/anon';

function memoryStore(initial: string | null = null): AnonStore & { value: string | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (v: string) => {
      store.value = v;
    },
  };
  return store;
}

const DAY = 24 * 60 * 60 * 1000;

describe('anonymous numbering', () => {
  it('numbers people from 1, oldest page first, and keeps each number', () => {
    const reg = new AnonRegistry(memoryStore());
    expect(reg.assign([{ id: 'b', createdAt: 2000 }, { id: 'a', createdAt: 1000 }])).toBe(true);
    expect(reg.numberFor('a')).toBe(1);
    expect(reg.numberFor('b')).toBe(2);
    // Asking again changes nothing.
    expect(reg.assign([{ id: 'a', createdAt: 1000 }])).toBe(false);
    expect(reg.numberFor('a')).toBe(1);
    expect(reg.numberFor('unknown')).toBeUndefined();
  });

  it('never reuses a number, even after earlier pages are gone', () => {
    const reg = new AnonRegistry(memoryStore());
    reg.assign([{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }]);
    // Page "a" erased and is no longer offered; a new person arrives.
    reg.assign([{ id: 'c', createdAt: 3 }]);
    expect(reg.numberFor('c')).toBe(3);
  });

  it('survives a reload', () => {
    const store = memoryStore();
    new AnonRegistry(store).assign([{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }]);
    const again = new AnonRegistry(store);
    expect(again.numberFor('a')).toBe(1);
    expect(again.numberFor('b')).toBe(2);
    again.assign([{ id: 'c', createdAt: 3 }]);
    expect(again.numberFor('c')).toBe(3);
  });

  it('forgets pages after two months but keeps counting upwards', () => {
    const store = memoryStore();
    const reg = new AnonRegistry(store);
    const start = 1_000_000;
    reg.assign([{ id: 'a', createdAt: 1 }], start);
    reg.assign([{ id: 'b', createdAt: 2 }], start + 61 * DAY);
    expect(reg.numberFor('a')).toBeUndefined();
    expect(reg.numberFor('b')).toBe(2);
  });

  it('starts again from 1 if the stored data is damaged', () => {
    for (const bad of ['not json', '{"next":"x"}', '{"next":0,"ids":{}}', '[]', 'null']) {
      const reg = new AnonRegistry(memoryStore(bad));
      reg.assign([{ id: 'a', createdAt: 1 }]);
      expect(reg.numberFor('a')).toBe(1);
    }
  });

  it('never hands out a number already in use, whatever the stored counter says', () => {
    const store = memoryStore(JSON.stringify({ next: 1, ids: { a: { n: 5, at: Date.now() } } }));
    const reg = new AnonRegistry(store);
    reg.assign([{ id: 'b', createdAt: 1 }]);
    expect(reg.numberFor('a')).toBe(5);
    expect(reg.numberFor('b')).toBe(6);
  });
});
