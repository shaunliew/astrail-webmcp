# Demo prompts — copy from here while recording

> Keep this open in a second window. Every prompt is **bare** on purpose: an agent picking the
> right tool out of ordinary language is part of what is being demonstrated.
>
> Full flow and timing: `VIDEO-FLOW.md`. What PASS looks like per beat: `DEMO-RUN.md`.

## ⚠️ Before take one — clear the memory

The agent asks how you travel ONLY when mem0 is **definitely empty**. Every rehearsal writes a
memory, so a second run of this flow silently skips the beat that earns trip 2's payoff — the
judge would watch Astrail recall something they never saw it learn.

There is no in-app reset: `POST /settings/memory/clear` is deliberately gated off. Clear it from
mem0's own dashboard, then confirm `/app/settings` reads "Astrail hasn't remembered anything yet"
before you hit record. **This is the one prerequisite that cannot be recovered mid-take.**

---

# TRIP 1 — Tokyo · it learns

## 1 · Orientation — on an empty account

```
What can I do here?
```

## 2 · Save the reels

```
Save these reels: <url1> <url2> <url3> <url4>
```

## 3 · Plan it — and it asks

```
Use the reels I just saved and plan me 2 days in Tokyo, 15 to 16 November 2026
```

**It will come back with a question**, because nothing is remembered yet. Answer out loud:

```
walkable days, good ramen, not too rushed
```

That answer is what gets remembered. The approval card then echoes `Preferences: "…"` verbatim —
**you can see the capture before anything is spent.** If the card does not show it, decline and
rephrase; nothing is lost.

**Give the dates.** They are required by the tool, so "plan me 2 days" alone makes the agent stop
and ask — an awkward pause for the wrong reason.

## 4 · Edit it live

```
Add Tokyo Disneyland to day 2
```

---

# TRIP 2 — Osaka · it remembers

⚠️ **A NEW ChatGPT conversation.** Any non-blank `preferences` deterministically suppresses recall,
and a model that just heard you say "walkable days, ramen" has every reason to resend it. A fresh
conversation removes the incentive; nothing else reliably does.

**Osaka, not Tokyo.** A different city makes the point land without narration — same taste, new
trip. Two Tokyo trips look alike on camera and the viewer has to take the difference on faith.

## 5 · Save the second pair

```
Save these reels: <url1> <url2>
```

## 6 · Plan it — state NO preference

```
Use the reels I just saved and plan me 2 days in Osaka, 15 to 16 December 2026
```

**This is the payoff.** The approval card names what Astrail remembers and offers a field to say
otherwise:

```
Astrail remembers: walkable days · good ramen · not too rushed
[ different this trip? (optional) ______________ ]
[ Try what it remembers ]   [ Not now ]
```

Astrail knows you, and it still asks. Approve blank and the first stage row reads *"Using your
saved travel preferences: …"* — **cut there.** The rest of the generation is wait, not story.

**Worth a second take if you have the seconds:** type something different into the field and let
the trip be built from that instead. That proves the memory is a suggestion rather than a rail,
which is the harder half to show and the easier half for a judge to doubt.

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
