import { describe, it, expect } from 'vitest';
import {
  slugify,
  validateImageExtension,
  shipAttributes,
  crewAttributes,
  buildMetadata,
  imageUrl,
  metadataUrl,
  assertUriLength,
} from '../../scripts/mint-nft.js';

describe('slugify', () => {
  it('lowercases and turns non-alphanumerics into a single dash', () => {
    expect(slugify('SH-001 Rustbucket')).toBe('sh-001-rustbucket');
  });
  it('collapses runs of separators', () => {
    expect(slugify('CR-002   Void  Runner!!')).toBe('cr-002-void-runner');
  });
  it('trims leading and trailing separators', () => {
    expect(slugify('--Weird Name--')).toBe('weird-name');
  });
  it('handles unicode/punctuation-only fragments', () => {
    expect(slugify("Cap'n O'Malley")).toBe('cap-n-o-malley');
  });
  it('reduces an all-separator string to empty', () => {
    expect(slugify('!!!   ---')).toBe('');
  });
});

describe('validateImageExtension', () => {
  it('accepts the supported extensions case-insensitively', () => {
    expect(validateImageExtension('art.png')).toBe('.png');
    expect(validateImageExtension('art.JPG')).toBe('.jpg');
    expect(validateImageExtension('/some/dir/art.jpeg')).toBe('.jpeg');
    expect(validateImageExtension('art.webp')).toBe('.webp');
  });
  it('throws a clear error for unsupported extensions', () => {
    expect(() => validateImageExtension('art.gif')).toThrow(/unsupported image extension/);
  });
  it('throws a clear error when there is no extension at all', () => {
    expect(() => validateImageExtension('art')).toThrow(/unsupported image extension/);
  });
});

describe('shipAttributes', () => {
  it('produces ENGINE / CARGO / BRIDGE / HULL traits in order', () => {
    expect(shipAttributes(12, 30, 4, 9)).toEqual([
      { trait_type: 'ENGINE', value: 12 },
      { trait_type: 'CARGO', value: 30 },
      { trait_type: 'BRIDGE', value: 4 },
      { trait_type: 'HULL', value: 9 },
    ]);
  });
});

describe('crewAttributes', () => {
  it('emits one attribute per positive skill, uppercased', () => {
    expect(crewAttributes({ fuel: 3, attack: 0, defense: 5 })).toEqual([
      { trait_type: 'FUEL', value: 3 },
      { trait_type: 'DEFENSE', value: 5 },
    ]);
  });
  it('is empty when no skills are set', () => {
    expect(crewAttributes({ fuel: 0, attack: 0, defense: 0 })).toEqual([]);
  });
});

describe('buildMetadata', () => {
  it('builds Metaplex-standard ship metadata', () => {
    const attrs = shipAttributes(10, 20, 2, 8);
    const meta = buildMetadata('ship', 'SH-001 Rustbucket', 'sh-001-rustbucket', '.png', attrs);
    expect(meta).toEqual({
      name: 'SH-001 Rustbucket',
      symbol: 'SKYH',
      description: 'Skyharbour ship — cargo over the void.',
      image: 'https://raw.githubusercontent.com/duOCELOT/skyharbour/main/nft/sh-001-rustbucket.png',
      attributes: attrs,
    });
  });
  it('builds Metaplex-standard crew metadata', () => {
    const attrs = crewAttributes({ fuel: 3, attack: 0, defense: 5 });
    const meta = buildMetadata('crew', 'CR-002 Skid', 'cr-002-skid', '.jpg', attrs);
    expect(meta).toEqual({
      name: 'CR-002 Skid',
      symbol: 'SKYH',
      description: 'Skyharbour crew — cargo over the void.',
      image: 'https://raw.githubusercontent.com/duOCELOT/skyharbour/main/nft/cr-002-skid.jpg',
      attributes: attrs,
    });
  });
});

describe('imageUrl / metadataUrl', () => {
  it('builds the raw GitHub image url', () => {
    expect(imageUrl('sh-001-rustbucket', '.png')).toBe(
      'https://raw.githubusercontent.com/duOCELOT/skyharbour/main/nft/sh-001-rustbucket.png',
    );
  });
  it('builds the raw GitHub metadata url', () => {
    expect(metadataUrl('sh-001-rustbucket')).toBe(
      'https://raw.githubusercontent.com/duOCELOT/skyharbour/main/nft/sh-001-rustbucket.json',
    );
  });
});

describe('assertUriLength', () => {
  it('allows uris at or under 200 chars', () => {
    expect(() => assertUriLength('a'.repeat(200))).not.toThrow();
  });
  it('throws for uris over 200 chars', () => {
    expect(() => assertUriLength('a'.repeat(201))).toThrow(/exceeds 200 chars/);
  });
});
