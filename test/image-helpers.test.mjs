import assert from 'node:assert/strict';
import { splitDataUrl, isOwnImaginePath, isOwnDebugPath, separateReasoning } from '../image-helpers.js';

// splitDataUrl
{
    const r = splitDataUrl('data:image/png;base64,AAAB');
    assert.equal(r.format, 'png');
    assert.equal(r.rawB64, 'AAAB');
}
{
    const r = splitDataUrl('data:image/jpeg;base64,ZZZ');
    assert.equal(r.format, 'jpeg');
}
assert.throws(() => splitDataUrl('user/images/x/imagine_1.png'), /bad_data_url/);
assert.throws(() => splitDataUrl('data:text/plain;base64,AAAA'), /bad_data_url/);

// isOwnImaginePath — must ONLY match our own generated files
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1720000000000_0.png'), true);
assert.equal(isOwnImaginePath('user/images/comfy-imagine/imagine_migrated_1720000000000_3.webp'), true);
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1.JPG'), true);
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1.bmp'), true);
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1.jfif'), true);
// must NOT match foreign files
assert.equal(isOwnImaginePath('user/images/Alice/vacation.png'), false);
assert.equal(isOwnImaginePath('user/images/Alice/portrait_imagine.png'), false);
assert.equal(isOwnImaginePath('user/files/Alice/imagine_1.png'), false);
assert.equal(isOwnImaginePath('../../etc/passwd'), false);
assert.equal(isOwnImaginePath('user/images/imagine_1.png'), false); // no subfolder

// regression: prefix-anchor bypass — suffix match must not be enough
assert.equal(isOwnImaginePath('../../../etc/user/images/x/imagine_1.png'), false);
assert.equal(isOwnImaginePath('/home/attacker/foo/user/images/x/imagine_1.png'), false);
assert.equal(isOwnImaginePath('C:/Windows/System32/user/images/x/imagine_1.png'), false);
// regression: `.`/`..` subfolder bypass
assert.equal(isOwnImaginePath('user/images/../imagine_1.png'), false);
assert.equal(isOwnImaginePath('user/images/./imagine_1.png'), false);
// still matches legitimate own-generated files
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1720000000000_0.png'), true);
assert.equal(isOwnImaginePath('user/images/comfy-imagine/imagine_migrated_1720000000000_3.webp'), true);

// regression: ST's /api/images/upload returns the path with a LEADING SLASH
// (clientRelativePath slices the root off an absolute path). This is the real
// format stored in mes/extra.imaginePath, and it must be recognized as own.
assert.equal(isOwnImaginePath('/user/images/Alice/imagine_1720000000000_0.png'), true);
assert.equal(isOwnImaginePath('/user/images/comfy-imagine/imagine_migrated_1720000000000_3.webp'), true);
assert.equal(isOwnImaginePath('/user/images/Alice/imagine_1.jpeg'), true);
// leading slash must not open a bypass: an absolute foreign path still fails
assert.equal(isOwnImaginePath('//user/images/x/imagine_1.png'), false);
assert.equal(isOwnImaginePath('/etc/user/images/x/imagine_1.png'), false);

// isOwnDebugPath — only our imagine_debug_*.json under user/files/
assert.equal(isOwnDebugPath('/user/files/imagine_debug_1783836108170_0.json'), true);
assert.equal(isOwnDebugPath('user/files/imagine_debug_1.json'), true);
assert.equal(isOwnDebugPath('/user/files/imagine_debug_migrated_2.json'), true);
// must NOT match foreign / wrong-shape files
assert.equal(isOwnDebugPath('/user/files/notes.json'), false);
assert.equal(isOwnDebugPath('/user/files/imagine_debug_1.txt'), false);
assert.equal(isOwnDebugPath('/user/images/Alice/imagine_1.png'), false);
assert.equal(isOwnDebugPath('/user/files/sub/imagine_debug_1.json'), false); // no subfolder allowed
assert.equal(isOwnDebugPath('/etc/user/files/imagine_debug_1.json'), false);
// the image gate must NOT match debug files, and vice versa
assert.equal(isOwnImaginePath('/user/files/imagine_debug_1.json'), false);

// separateReasoning — pull chain-of-thought out of the reply however it's shaped
{
    // plain prompt, no reasoning
    const r = separateReasoning('a cat on a roof');
    assert.equal(r.prompt, 'a cat on a roof');
    assert.equal(r.reasoning, '');
}
{
    // well-formed pair
    const r = separateReasoning('<think>let me plan</think>a cat on a roof');
    assert.equal(r.prompt, 'a cat on a roof');
    assert.equal(r.reasoning, 'let me plan');
}
{
    // the reported failure: opening tag eaten, only closing survives
    const r = separateReasoning('let me plan the scene</think>a cat on a roof');
    assert.equal(r.prompt, 'a cat on a roof');
    assert.equal(r.reasoning, 'let me plan the scene');
}
{
    // variant tag name
    const r = separateReasoning('<thinking>hmm</thinking>a dog');
    assert.equal(r.prompt, 'a dog');
    assert.equal(r.reasoning, 'hmm');
}
{
    // truncated mid-thought: opening tag, no close -> no prompt salvageable
    const r = separateReasoning('a dog<think>now I should');
    assert.equal(r.prompt, 'a dog');
    assert.equal(r.reasoning, 'now I should');
}
{
    // all reasoning, no prompt (unclosed from the very start)
    const r = separateReasoning('<think>thinking hard and ran out');
    assert.equal(r.prompt, '');
    assert.equal(r.reasoning, 'thinking hard and ran out');
}
{
    // case-insensitive close, whitespace trimmed around prompt
    const r = separateReasoning('reasoning here</THINK>\n  a bright sky  ');
    assert.equal(r.prompt, 'a bright sky');
    assert.equal(r.reasoning, 'reasoning here');
}
{
    // untagged reasoning: last paragraph is the prompt
    const r = separateReasoning('Let me think about the scene.\nThe user is in a kitchen.\n\nPOV shot, close-up. A steaming mug on a wooden table.');
    assert.equal(r.prompt, 'POV shot, close-up. A steaming mug on a wooden table.');
    assert.equal(r.reasoning, 'Let me think about the scene.\nThe user is in a kitchen.');
}
{
    // untagged, several reasoning paragraphs then the prompt
    const r = separateReasoning('First, the setting.\n\nNext, the lighting.\n\nA misty forest at dawn, soft light.');
    assert.equal(r.prompt, 'A misty forest at dawn, soft light.');
    assert.equal(r.reasoning, 'First, the setting.\n\nNext, the lighting.');
}
{
    // single paragraph, no tags -> whole thing is the prompt, nothing chopped
    const r = separateReasoning('A ginger cat perched on a terracotta roof at golden hour.');
    assert.equal(r.prompt, 'A ginger cat perched on a terracotta roof at golden hour.');
    assert.equal(r.reasoning, '');
}
{
    // tags win over the paragraph fallback: multi-paragraph prompt stays whole
    const r = separateReasoning('<think>planning</think>Paragraph one of the prompt.\n\nParagraph two of the prompt.');
    assert.equal(r.prompt, 'Paragraph one of the prompt.\n\nParagraph two of the prompt.');
    assert.equal(r.reasoning, 'planning');
}

console.log('image-helpers: all checks passed');
