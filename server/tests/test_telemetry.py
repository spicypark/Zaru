"""Latency histograms use explicit buckets so SLO thresholds sit on a bucket edge."""

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from zaru.telemetry import LATENCY_BUCKETS_MS, LATENCY_HISTOGRAMS, latency_views


def _collect(reader: InMemoryMetricReader) -> dict:
    data = reader.get_metrics_data()
    return {
        metric.name: metric.data.data_points[0]
        for resource_metrics in data.resource_metrics
        for scope_metrics in resource_metrics.scope_metrics
        for metric in scope_metrics.metrics
    }


@pytest.mark.parametrize("name", LATENCY_HISTOGRAMS)
def test_latency_histogram_uses_explicit_buckets(name: str) -> None:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader], views=latency_views())
    histogram = provider.get_meter("zaru").create_histogram(name, unit="ms")

    histogram.record(1400)  # within the 1.5 s caption SLO
    histogram.record(1600)  # just outside it

    point = _collect(reader)[name]
    assert tuple(point.explicit_bounds) == LATENCY_BUCKETS_MS
    le_1500 = LATENCY_BUCKETS_MS.index(1500)
    assert point.bucket_counts[le_1500] == 1
    assert point.bucket_counts[le_1500 + 1] == 1
    assert sum(point.bucket_counts) == 2


def test_other_histograms_keep_default_buckets() -> None:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader], views=latency_views())
    provider.get_meter("zaru").create_histogram("zaru.other_ms").record(1)

    assert tuple(_collect(reader)["zaru.other_ms"].explicit_bounds) != LATENCY_BUCKETS_MS
