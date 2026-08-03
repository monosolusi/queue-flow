import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDBY_CONTENT,
  resolveRunningText,
  type MediaAsset,
} from './standby-content';

describe('DEFAULT_STANDBY_CONTENT', () => {
  it('exposes a non-empty running text with the {storeName} placeholder', () => {
    expect(DEFAULT_STANDBY_CONTENT.runningText.length).toBeGreaterThan(0);
    expect(DEFAULT_STANDBY_CONTENT.runningText).toContain('{storeName}');
  });

  it('lists at least one media asset so the idle screen is never empty', () => {
    expect(DEFAULT_STANDBY_CONTENT.media.length).toBeGreaterThanOrEqual(1);
  });

  it('every media asset has a valid kind and non-empty name', () => {
    for (const asset of DEFAULT_STANDBY_CONTENT.media as readonly MediaAsset[]) {
      expect(asset.name.length).toBeGreaterThan(0);
      expect(['image', 'video']).toContain(asset.kind);
    }
  });
});

describe('resolveRunningText', () => {
  it('substitutes {storeName} with the configured store name', () => {
    expect(
      resolveRunningText('Selamat datang di {storeName}', 'Apotek Sehat'),
    ).toBe('Selamat datang di Apotek Sehat');
  });

  it('falls back to a neutral label when the store name is unset', () => {
    expect(resolveRunningText('Selamat datang di {storeName}', '')).toBe(
      'Selamat datang di layanan antrian kami',
    );
    expect(resolveRunningText('Selamat datang di {storeName}', undefined)).toBe(
      'Selamat datang di layanan antrian kami',
    );
    expect(resolveRunningText('Selamat datang di {storeName}', null)).toBe(
      'Selamat datang di layanan antrian kami',
    );
  });

  it('returns the text unchanged when there is no placeholder', () => {
    expect(resolveRunningText('Mohon perhatikan nomor antrian Anda', 'X')).toBe(
      'Mohon perhatikan nomor antrian Anda',
    );
  });
});