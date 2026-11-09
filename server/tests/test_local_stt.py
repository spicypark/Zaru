import numpy as np

from zaru.local_stt import _is_hallucination, pcm16_24k_to_float_16k


def test_resamples_24k_pcm16_to_16k_float() -> None:
    one_second = (np.ones(24_000, dtype="<i2") * 16384).tobytes()
    audio = pcm16_24k_to_float_16k(one_second)
    assert audio.dtype == np.float32
    assert audio.size == 16_000
    assert np.allclose(audio, 0.5)


def test_filters_whisper_silence_hallucinations() -> None:
    assert _is_hallucination("Thank you.")
    assert _is_hallucination(" you")
    assert not _is_hallucination("Thank you for coming to my talk.")
