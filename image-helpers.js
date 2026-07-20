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

// Reasoning models fold their chain-of-thought into the reply as a tagged
// block. It comes back malformed often enough that a single <tag>...</tag>
// regex isn't enough: the opening tag gets eaten, only a closing </think>
// survives, a variant tag name is used, or the reply is truncated mid-thought
// with no close at all. separateReasoning pulls the reasoning out of `content`
// however it's shaped and returns { prompt, reasoning } — prompt is what's
// safe to send to the image model, reasoning is for the debug modal only.
const REASONING_TAGS = 'think|thinking|thought|reason|reasoning';

export function separateReasoning(content) {
    let text = String(content ?? '');
    const reasoning = [];

    // 1. Well-formed <tag>...</tag> pairs, anywhere in the text.
    const pair = new RegExp(`<(${REASONING_TAGS})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
    text = text.replace(pair, (_m, _tag, inner) => { reasoning.push(inner); return ''; });

    // 2. Stray closing tag, opening eaten: everything up to the LAST close is
    //    reasoning; the real prompt is whatever follows it.
    const close = new RegExp(`<\\/(?:${REASONING_TAGS})\\s*>`, 'gi');
    let lastClose = -1, m;
    while ((m = close.exec(text)) !== null) lastClose = m.index + m[0].length;
    if (lastClose !== -1) {
        reasoning.unshift(text.slice(0, lastClose).replace(close, ''));
        text = text.slice(lastClose);
    }

    // 3. Stray opening tag, no close (truncated mid-thought): the tail is
    //    unfinished reasoning, not a prompt — drop it.
    const open = new RegExp(`<(?:${REASONING_TAGS})\\b[^>]*>`, 'i');
    const om = open.exec(text);
    if (om) {
        reasoning.push(text.slice(om.index + om[0].length));
        text = text.slice(0, om.index);
    }

    return { prompt: text.trim(), reasoning: reasoning.join('\n').trim() };
}

// True only for debug sidecar files THIS extension created: an
// `imagine_debug_` JSON directly under user/files/ (ST's file store is flat,
// no subfolder). Gates the file-delete endpoint the same way isOwnImaginePath
// gates image deletion. Leading slash optional (upload returns one).
export function isOwnDebugPath(path) {
    return /^\/?user\/files\/imagine_debug_[^/]+\.json$/i.test(path ?? '');
}
