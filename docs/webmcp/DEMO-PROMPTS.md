# Demo prompts — copy from here while recording

> Keep this open in a second window. Every prompt is **bare** on purpose: an agent picking the
> right tool out of ordinary language is part of what is being demonstrated.
>
> Full flow and timing: `VIDEO-FLOW.md`. What PASS looks like per beat: `DEMO-RUN.md`.

## 1 · Orientation — on an empty account

```
What can I do here?
```

## 2 · Save the reels — paste your three links

```
Save these reels: <url1> <url2> <url3>
```

## 3 · Plan it — the main feature

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November
```

**Memory:** this prompt supplies no preferences, which is exactly what makes mem0 recall fire
(`pipeline/preferences.py:114`). If the account has remembered facts, the first stage row reads
"Using your saved travel preferences: …" and carries a brass `Memory` chip — that is the only
branch worth narrating. Prep, gates and the line to say: `MEMORY-BEAT.md`.

**Give the dates.** They are required by the tool, so "plan me 2 days" alone makes the agent stop
and ask — an awkward pause mid-take.

## 4 · Edit it live

```
Add Tokyo Disneyland to day 1
```

---

## Then, with no prompt

Zoom the map in on the new pin. Buildings extrude past z15. **No tool sets 3D**, so do not ask the
agent for it and do not imply it did — the honest line is better: the agent put the stop on the
map, you looked around it.

## If a prompt does not reach the tools

ChatGPT sometimes drives the browser instead. Ask it to use Astrail's own tools and repeat the
prompt. Which tool an agent reaches for is ChatGPT's decision, not something a site can control.

`tmux attach -t astrailapi` in a second window: **silence in that log means the DOM was driven
instead of a tool being called.** Identical on screen, obvious in the log.
