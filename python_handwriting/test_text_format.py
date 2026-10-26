import unittest
from text_format import normalize_inscription_linebreaks


class InscriptionLinebreakTests(unittest.TestCase):
    def test_literal_escaped_newlines(self):
        raw = r"PERSONA DE PRUEBA\n* 1-1-2000\n\nTEXTO DE PRUEBA"
        self.assertEqual(normalize_inscription_linebreaks(raw), "PERSONA DE PRUEBA\n* 1-1-2000\n\nTEXTO DE PRUEBA")

    def test_escaped_windows_linebreaks(self):
        self.assertEqual(normalize_inscription_linebreaks(r"LÍNEA 1\r\nLÍNEA 2"), "LÍNEA 1\nLÍNEA 2")

    def test_existing_real_linebreaks_remain_untouched(self):
        raw = "LÍNEA 1\nLÍNEA 2"
        self.assertEqual(normalize_inscription_linebreaks(raw), raw)

    def test_mixed_ambiguous_input_is_not_modified(self):
        raw = "LÍNEA 1\nLÍNEA 2" + r"\nLÍNEA 3"
        self.assertEqual(normalize_inscription_linebreaks(raw), raw)

    def test_empty_and_unrelated_backslash_are_unchanged(self):
        self.assertEqual(normalize_inscription_linebreaks(None), "")
        self.assertEqual(normalize_inscription_linebreaks(r"SÍMBOLO \ Y TEXTO"), r"SÍMBOLO \ Y TEXTO")

    def test_idempotent(self):
        raw = r"LÍNEA 1\nLÍNEA 2"
        once = normalize_inscription_linebreaks(raw)
        self.assertEqual(normalize_inscription_linebreaks(once), once)


if __name__ == "__main__":
    unittest.main()
