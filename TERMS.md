# Gnosis — Terms of Use

**Version 1 · Effective 2026-08-31**

Gnosis ("the Software") is free, open-source software published by the Gnosis
project ("we", "us"). By installing or using it you agree to these terms. If you
do not agree, do not install or use it.

---

## 1. Licence

The Software is licensed to you under the **MIT Licence**, reproduced in the
`LICENSE` file distributed with it. You may use, copy, modify and redistribute it
under those terms, for personal or commercial purposes, at no cost.

These Terms describe how the Software behaves and how responsibility is
allocated. Where these Terms and the MIT Licence differ, the MIT Licence governs
the copyright grant and these Terms govern your use of the Software.

## 2. What the Software does — read this part

Gnosis is an **autonomous agent**, not a chat window. When instructed, and
subject to the permission prompts described in §3, it can:

- run shell commands on your computer;
- create, modify and permanently delete files;
- make network requests and send data to third-party services;
- control your mouse, keyboard and screen, and read what is displayed;
- install software, and start and stop other programs;
- commit to, and modify, source control repositories.

It acts on instructions written in ordinary language and interpreted by a
language model. **Language models misinterpret instructions, act on incorrect
assumptions, and make mistakes.** Some actions it takes cannot be undone.

## 3. Permissions, and their limits

The Software asks for confirmation before actions it classifies as dangerous,
and refuses some outright. These safeguards are **best-effort engineering, not
guarantees.** They can be misconfigured, disabled by you (for example by
selecting "yolo" mode or answering "always"), or simply fail to recognise a
harmful action.

You must not rely on them as your only protection. Keep backups.

## 4. Your responsibility

**You are solely responsible for:**

- every instruction you give the Software, and everything that results from it;
- the data, systems, accounts and repositories you point it at;
- ensuring you have the right to access and modify anything you direct it to;
- reviewing its output before relying on it, including code, commands and
  factual claims;
- complying with all laws that apply to you and to your use of it;
- the terms of any third-party service you configure it to use.

**You must not** use the Software to break the law, to access systems you are not
authorised to access, to harm others, or in any application where a failure could
lead to injury, death, or serious environmental or financial damage — including
medical, aviation, automotive, weapons, critical-infrastructure or life-support
systems. It is not designed, tested or certified for those uses.

You must be old enough to form a binding contract where you live.

## 5. Data — what we collect, and what leaves your computer

**We collect nothing.** The Gnosis project operates no servers, no analytics, no
telemetry and no accounts. We never receive your prompts, files, keystrokes,
screen contents, recordings or API keys, and we could not read them if we wanted
to. Your conversations, sessions, keys and generated files stay on your computer,
in `~/.dom` and `~/Gnosis`.

**However, the Software is not offline.** To function it sends data to services
that *you* configure with *your* own API keys:

| Service | What is sent | When |
| --- | --- | --- |
| **OpenRouter** | Your prompts, and the contents of files the agent reads | Always — the Software cannot work without it |
| **Groq** | Recordings of your speech, for transcription | Whenever you speak to it after the wake phrase (voice is on by default) |
| **Brave Search** | Your search terms | Only if you use web search |
| **GitHub** | A version number, to check for updates | On launch and periodically |
| **Any MCP server you add** | Whatever that server's tools are given | Only if you configure it |

These are independent companies. Your data reaches them under **their** terms and
privacy policies, not ours, and we have no control over and no responsibility for
what they do with it. Review their policies before sending anything sensitive.

**Voice.** Voice is **enabled by default** from version 1.3 onwards. It does not
start until after you have been shown these Terms, and the window that shows them
carries a switch to turn it off before anything listens. Wake-word detection
("hey jarvis") runs entirely on your computer and
no audio leaves it while the Software is merely listening for the wake phrase.
After the wake phrase is detected, the speech you then say is recorded and sent
to Groq to be transcribed. Voice can be switched off at any time in Settings, or
with the × on the voice panel. Do not enable voice on a device where others may
be recorded without their knowledge or consent — **that is your responsibility,
and the law in many places requires consent from everyone recorded.**

## 6. No warranty

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.**

We do not warrant that it will work, that it will be available, that it will be
free of errors or security defects, or that its output will be accurate,
complete or fit for any purpose.

## 7. Limitation of liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.**

This includes, without limitation, lost or corrupted data, lost profits, lost
revenue, business interruption, costs incurred with third-party services
(including API charges), unauthorised disclosure of information, and damage
caused by actions the agent took — whether or not we were advised of the
possibility of such damage, and whether or not such actions were the result of a
defect.

The Software is provided free of charge. Where liability cannot lawfully be
excluded, our total aggregate liability to you is limited to the greater of the
amount you paid us for the Software (which is nothing) or USD $0.

## 8. Indemnity

You agree to indemnify and hold harmless the authors and copyright holders from
any claim, demand, loss or expense (including reasonable legal fees) arising out
of your use of the Software, your breach of these Terms, or your violation of any
law or the rights of any third party.

## 9. Third-party components

The Software bundles and downloads open-source components, each under its own
licence, including Electron, Node.js, and — if you enable voice — openWakeWord
and Kokoro. Optional components are downloaded from their publishers at your
request. Those licences govern those components.

## 10. Consumer rights

Nothing in these Terms excludes or limits any right you have that cannot lawfully
be excluded or limited, including statutory consumer rights. If a provision is
found unenforceable, the rest remains in force.

## 11. Changes

These Terms may change in later versions of the Software. The version you
accepted is recorded on your own computer, in `~/.dom/acceptance.json`, together
with a checksum of the exact text you were shown. Material changes are presented
for acceptance again when you update.

## 12. Contact

Issues and questions: https://github.com/DOMCHURCH/Gnosis/issues

---

*These Terms are a good-faith description of how the Software works and how
responsibility is allocated. They are not legal advice, and they have not been
reviewed by a lawyer. If you are deploying Gnosis commercially or in a regulated
setting, get your own advice.*
