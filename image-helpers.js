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
// ST's upload endpoint returns the path with a leading slash
// (`/user/images/<char>/imagine_...png`, via clientRelativePath), so the
// leading slash is optional here. The path must otherwise be root-relative
// and normalized: the regex is anchored to the true start of the string (not
// just a suffix match), and the subfolder segment cannot be `.` or `..`, so a
// path-traversal or "looks like a suffix" string can never be mistaken for
// one of our own files.
export function isOwnImaginePath(path) {
    return /^\/?user\/images\/(?!\.\.?\/)[^/]+\/imagine_[^/]+\.(png|jpe?g|webp|bmp|jfif)$/i.test(path ?? '');
}

// True only for debug sidecar files THIS extension created: an
// `imagine_debug_` JSON directly under user/files/ (ST's file store is flat,
// no subfolder). Gates the file-delete endpoint the same way isOwnImaginePath
// gates image deletion. Leading slash optional (upload returns one).
export function isOwnDebugPath(path) {
    return /^\/?user\/files\/imagine_debug_[^/]+\.json$/i.test(path ?? '');
}
