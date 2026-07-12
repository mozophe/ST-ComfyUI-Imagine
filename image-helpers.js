// Pure, SillyTavern-independent helpers for image storage. Kept separate from
// index.js so the security-relevant delete gate is testable in plain node.

// "data:image/png;base64,AAAA" -> { format: "png", rawB64: "AAAA" }
// Throws on anything that is not a base64 image data URL.
export function splitDataUrl(dataUrl) {
    const m = /^data:image\/(\w+);base64,(.*)$/s.exec(dataUrl ?? '');
    if (!m) throw new Error('bad_data_url');
    return { format: m[1], rawB64: m[2] };
}

// True only for files THIS extension created: an `imagine_` file inside a
// character subfolder under user/images/. Gates the delete endpoint so a
// foreign image referenced in chat can never be removed by cleanup.
export function isOwnImaginePath(path) {
    return /(^|\/)user\/images\/[^/]+\/imagine_[^/]+\.(png|jpe?g|webp)$/i.test(path ?? '');
}
