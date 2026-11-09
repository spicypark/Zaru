"""OpenTelemetry setup: traces, metrics and logs exported to Dash0 over OTLP/HTTP.

Export is enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set; the OTLP exporters read the
endpoint and auth headers from the standard OTEL_* environment variables themselves.

Privacy: spans, metrics and logs carry timings, counts and model names only. Never attach
transcript text, prompts containing user speech, or image bytes.
"""

import logging
import os

from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from zaru.config import Settings

log = logging.getLogger(__name__)

tracer = trace.get_tracer("zaru")
meter = metrics.get_meter("zaru")


def setup_telemetry(app: FastAPI, settings: Settings) -> None:
    logging.basicConfig(level=logging.INFO)

    if not os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"):
        log.info("OTEL_EXPORTER_OTLP_ENDPOINT not set; telemetry export disabled")
        return

    resource = Resource.create(
        {
            "service.name": os.getenv("OTEL_SERVICE_NAME", "zaru-server"),
            "deployment.environment.name": settings.deployment_environment,
        }
    )

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)

    metrics.set_meter_provider(
        MeterProvider(
            resource=resource,
            metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())],
        )
    )

    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(logger_provider)
    logging.getLogger().addHandler(LoggingHandler(logger_provider=logger_provider))

    # OpenLIT reuses the providers above (it detects an existing SDK provider) and adds
    # GenAI spans/metrics for every OpenAI call: model, tokens, cost, latency.
    # Message content capture is off so prompts and transcripts never leave the server.
    import openlit

    openlit.init(
        application_name="zaru-server",
        environment=settings.deployment_environment,
        capture_message_content=False,
        disable_events=True,
    )

    FastAPIInstrumentor.instrument_app(app)
    log.info("telemetry export enabled")
