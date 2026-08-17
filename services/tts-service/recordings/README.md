# Human voice recordings (`prerecorded` engine)

Drop one folder per speaker here; the folder name **is** the voice id shown in the
admin panel.

```
recordings/
  bu-sari/
    nomor.wav
    antrian.wav
    a.wav
    lima.wav
    silakan.wav
    ke.wav
    loket.wav
    dua.wav
    …
```

One WAV per spoken **word**. All files for one voice must share channel count,
sample width and sample rate (mono, 22 050 Hz matches the rest of the pipeline);
mixing rates would play some words at the wrong pitch, so the engine rejects it
rather than producing something subtly wrong.

## Why this exists

A receptionist reading ~40 short words sounds better than any small neural voice,
and it sidesteps the unresolved licensing of the bundled Piper voice. Switching to
it is a configuration change — no code, no redeploy of the TV board.

## The word list

The vocabulary is whatever `app/domain/indonesian_number.py` can emit plus the
fixed announcement phrases. For the numbers a single branch normally reaches:

```
nomor antrian silakan ke loket
nol satu dua tiga empat lima enam tujuh delapan sembilan
sepuluh sebelas belas puluh seratus ratus seribu ribu
a be ce de e ef ge ha i je ka el em en o pe ki er es te u fe we eks ye zet
```

If a word is missing the engine fails loudly and names every missing file — it
never drops a word, because an announcement missing its number is worse for a
visitor than an audible error.
