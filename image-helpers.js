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

    // 4. Untagged reasoning: some models think out loud with no tags at all,
    //    which can't be split structurally. Fall back to the convention that the
    //    LAST paragraph is the prompt and everything before it is reasoning. Only
    //    when no tag-based reasoning was found and there's more than one
    //    paragraph — a clean single-paragraph reply is left whole.
    // ponytail: paragraphs are blank-line delimited; reasoning glued to the
    // prompt with only single newlines won't split. The system prompt should be
    // written so the image prompt is its own final paragraph (see README).
    if (reasoning.length === 0) {
        const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        if (paras.length > 1) {
            text = paras[paras.length - 1];
            reasoning.push(paras.slice(0, -1).join('\n\n'));
        }
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

/**
 * Selects the chat-log window fed to the prompt LLM.
 * Cuts the log at uptoIndex (inclusive) when given, drops system messages,
 * then keeps the last `limit` messages (limit <= 0 = all). Pure; does not
 * mutate the input array.
 * @param {Array<{is_system?: boolean}>} messages Full chat array.
 * @param {?number} uptoIndex Index of the last message to include, or null for the whole log.
 * @param {number} limit Max non-system messages to keep (0 = all).
 * @returns {Array} The selected messages, oldest first.
 */
export function selectChatWindow(messages, uptoIndex = null, limit = 0) {
    let msgs = uptoIndex == null ? messages.slice() : messages.slice(0, uptoIndex + 1);
    msgs = msgs.filter(m => !m.is_system);
    if (limit > 0) msgs = msgs.slice(-limit);
    return msgs;
}
