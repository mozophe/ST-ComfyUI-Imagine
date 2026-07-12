import assert from 'node:assert/strict';
import { splitDataUrl, isOwnImaginePath } from '../image-helpers.js';

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

console.log('image-helpers: all checks passed');
