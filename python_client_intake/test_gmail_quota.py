"""Regression tests for bounded Gmail read-only quota recovery (no live API calls)."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from googleapiclient.errors import HttpError

from intake_readonly import execute_gmail_read


def http_error(status, reason):
    response = SimpleNamespace(status=status, reason="test")
    payload = ('{"error":{"errors":[{"reason":"' + reason + '"}]}}').encode()
    return HttpError(response, payload)


class FakeRequest:
    def __init__(self, results):
        self.results = list(results)
        self.calls = 0

    def execute(self):
        self.calls += 1
        value = self.results.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class GmailQuotaRetryTests(unittest.TestCase):
    @patch("intake_readonly.time.sleep")
    def test_403_rate_limit_recovers_without_duplicate_writes(self, sleep):
        request = FakeRequest([http_error(403, "rateLimitExceeded"), {"id": "ok"}])
        self.assertEqual(execute_gmail_read(request), {"id": "ok"})
        self.assertEqual(request.calls, 2)
        sleep.assert_called_once_with(20)

    @patch("intake_readonly.time.sleep")
    def test_429_recovers(self, sleep):
        request = FakeRequest([http_error(429, "rateLimitExceeded"), {"id": "ok"}])
        self.assertEqual(execute_gmail_read(request), {"id": "ok"})
        sleep.assert_called_once_with(20)

    @patch("intake_readonly.time.sleep")
    def test_permission_denied_does_not_retry(self, sleep):
        request = FakeRequest([http_error(403, "insufficientPermissions")])
        with self.assertRaises(HttpError):
            execute_gmail_read(request)
        self.assertEqual(request.calls, 1)
        sleep.assert_not_called()

    @patch("intake_readonly.time.sleep")
    def test_persistent_rate_limit_stops_after_four_calls(self, sleep):
        request = FakeRequest([http_error(403, "rateLimitExceeded") for _ in range(4)])
        with self.assertRaises(HttpError):
            execute_gmail_read(request)
        self.assertEqual(request.calls, 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [20, 40, 60])


if __name__ == "__main__":
    unittest.main()
