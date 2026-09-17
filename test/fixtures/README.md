# Audio transport fixture

`voice.aac` is a generated 0.5-second 440 Hz tone in AAC/ADTS, not a recording or user data.

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=16000' -t 0.5 -c:a aac -b:a 32k -f adts voice.aac
```

The host smoke verifies transport bytes and metadata against a deterministic local STT response. It does not evaluate speech recognition or contact a corporate endpoint.
