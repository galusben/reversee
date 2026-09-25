// content-type -> Monaco language id mapping used by the body viewer.
import { describe, it, expect } from 'vitest';
import { languageForContentType } from '../../src/renderer/src/lib/content-type';

describe('languageForContentType', () => {
  it.each([
    ['application/json', 'json'],
    ['application/json; charset=utf-8', 'json'],
    ['application/problem+json', 'json'],
    ['APPLICATION/JSON', 'json'],
    ['text/html', 'html'],
    ['application/xhtml+html', 'html'],
    ['text/css', 'css'],
    ['application/javascript', 'javascript'],
    ['text/javascript; charset=utf-8', 'javascript'],
    ['application/xml', 'xml'],
    ['text/xml', 'xml'],
    ['application/atom+xml', 'xml'],
    ['text/plain', 'plaintext'],
    ['application/octet-stream', 'plaintext'],
    ['', 'plaintext'],
    [undefined, 'plaintext'],
  ])('%s -> %s', (contentType, language) => {
    expect(languageForContentType(contentType)).toBe(language);
  });
});
