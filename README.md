# ComfyUI-Imagine

A SillyTavern extension that generates images on demand by reading the current chat context, sending it to an LLM to write a Stable Diffusion prompt, and posting it to a ComfyUI instance.

## Requirements

- SillyTavern `release` v1.18.0+
- A running ComfyUI instance
- An OpenAI-compatible LLM API endpoint (e.g. OpenAI, a local Ollama server, or any OpenAI-compatible API)

## Installation

In SillyTavern, open **Extensions** → **Install Extension**, paste the repo URL below, and click **Install**:

```
https://github.com/mozophe/ST-ComfyUI-Imagine
```

## Setup

1. **Start ComfyUI** — pick the command for your setup:

   **Same machine** (ComfyUI and SillyTavern on one computer):
   ```
   python main.py --enable-cors-header
   ```

   **Different machines** (e.g. SillyTavern on a Raspberry Pi, ComfyUI on a desktop):
   ```
   python main.py --listen 0.0.0.0 --enable-cors-header
   ```

   - `--enable-cors-header` — needed in **both** cases. SillyTavern and ComfyUI run on different ports, so the browser treats them as different origins and blocks `fetch` without this header — even on the same machine, even when the port is reachable via `curl`.
   - `--listen 0.0.0.0` — **only** for the different-machines case; it makes ComfyUI accept connections from other computers on the network. Omit it for a same-machine setup.
   - Add `--port <number>` to either command if you don't want the default port `8188`.
2. **ComfyUI Base URL** — point it at ComfyUI, then click **Test ComfyUI Connection** to verify:
   - **Same machine** — `http://localhost:8188`
   - **Different machine** — the ComfyUI computer's LAN IP and port, e.g. `http://192.168.1.50:8188`
3. **LLM** — enter your API base URL, API key, and model name. Click **Test API Connection** to verify.
4. **System Prompt Presets** — save the current system prompt under a name with **Save As**, switch between saved prompts via the dropdown, and remove one with the 🗑 button. Presets are stored in your SillyTavern settings.
5. **Upload a Workflow** — export your ComfyUI workflow in **API format** (enable Dev Mode in ComfyUI → Save API Format), then upload it here. Workflows are stored in your SillyTavern settings — no files are written to the server.
6. **Select Active Workflow** — choose the workflow to use. Use the 🗑 button to delete workflows you no longer need.
7. **Generation Settings** — image count (1–8), sender name for injected messages.

## Usage

Type `/imagine` in the chat input or attach it to a Quick Reply button. The extension will:

1. Gather the current character card, user persona, and chat history
2. Ask the configured LLM to write a prompt for Comfy UI
3. Post the prompt to ComfyUI and wait for the result
4. Inject the generated image into chat as a message from "Camera" (hidden from the main model)

Use ST's built-in **Abort** button to cancel generation mid-flight.

### Quick Reply Setup

To add a one-click image button to the chat bar:

1. Open the **Quick Reply** extension settings and create (or edit) a Quick Reply set, then add a new reply.
2. In the reply editor, set the **Message / Command** box to:
   ```
   /imagine
   ```
3. Give it a **Label** (e.g. `📷`) or pick an icon so it shows on the chat bar.
4. Leave the **Auto-Execute** options at their defaults — `Don't trigger auto-execute` should stay checked so it only fires when you click it.
5. Click **OK**, then enable the Quick Reply set so the button appears.

Clicking the button now runs `/imagine` exactly as typing it would.

![Quick Reply editor with /imagine command](docs/images/quick-reply.png)

Each generated image message has a ⓘ button in the message action row. Click it to open a debug modal showing the system prompt, the full LLM context (character + persona + chat log), and the generated image prompt.

## Security Note

The LLM API key is stored in SillyTavern's `settings.json` in plain text. Do not commit or share that file.

## Workflow Notes

- Workflows must be in **ComfyUI API export format** (not the standard UI format).
- The extension injects the LLM-generated prompt into the first `CLIPTextEncode` node (positive conditioning) and the negative prompt (if set) into the second.
- If image count > 1, the KSampler seed is randomised for each job.

### Custom Prompt Target Nodes

If you want to prepend a fixed keyword or prefix inside the workflow itself (e.g. using a string concat node), you can redirect injection away from `CLIPTextEncode` using node titles:

1. In ComfyUI, set the title of your **prompt-receiver** string node to `IMAGINE_PROMPT`.
2. Optionally, title your negative-prompt string node `IMAGINE_NEGATIVE`.
3. Export the workflow in API format and upload it.

The extension will inject into those titled nodes instead of the first/second `CLIPTextEncode`. Fallback to `CLIPTextEncode` order applies when no titled nodes are found (existing workflows are unaffected).

Both `inputs.text` (most custom string nodes) and `widgets_values[0]` (ComfyUI's built-in `PrimitiveNode`) are supported.
