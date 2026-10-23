"""Regression tests for bounded Gmail read-only quota recovery (no live API calls)."""
import unittest
from collections import Counter
from types import SimpleNamespace
from unittest.mock import patch

from googleapiclient.errors import HttpError

from intake_readonly import execute_gmail_read, unique_corel_name
from intake_sync import set_if_blank


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


class CorelLinkRegressionTests(unittest.TestCase):
    def test_exactly_one_cdr_is_selected(self):
        self.assertEqual(unique_corel_name(["1001-0.jpg", "1001-2.CDR"]), "1001-2.CDR")
        self.assertIsNone(unique_corel_name(["1001-0.jpg"]))
        self.assertIsNone(unique_corel_name(["1001-a.cdr", "1001-b.cdr"]))

    @patch("intake_sync.update_value")
    def test_corel_link_written_once_and_existing_value_preserved(self, update):
        header = "Archivo Corel (CDR)"
        state = {"columns": {header: 30}, "row_values": {9: [""] * 31}}
        counters = Counter()
        set_if_blank(None, state, 9, header, "synthetic-drive-link", counters)
        set_if_blank(None, state, 9, header, "different-link", counters)
        update.assert_called_once_with(None, "Pedidos", 9, 30, "synthetic-drive-link")
        self.assertEqual(counters["sheet_cells"], 1)
        self.assertEqual(state["row_values"][9][30], "synthetic-drive-link")


if __name__ == "__main__":
    unittest.main()
