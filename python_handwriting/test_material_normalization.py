"""Synthetic regression tests: M4 must honor explicit material aliases."""

import unittest

from sync import normalize_material


class MaterialNormalizationTests(unittest.TestCase):
    def test_italia_overrides_generic_blanco(self):
        self.assertEqual(normalize_material("Mármol blanco Italia"), "Mármol blanco Italia")
        self.assertEqual(normalize_material("Blanco Italia"), "Mármol blanco Italia")

    def test_explicit_italia_aliases(self):
        self.assertEqual(normalize_material("Italia"), "Mármol blanco Italia")
        self.assertEqual(normalize_material("Italiano"), "Mármol blanco Italia")
        self.assertEqual(normalize_material("IT"), "Mármol blanco Italia")

    def test_other_existing_aliases_unchanged(self):
        self.assertEqual(normalize_material("Blanco A/AB"), "Mármol blanco macael")
        self.assertEqual(normalize_material("Absoluto"), "Granito negro absoluto")
        self.assertEqual(normalize_material("Suyo"), "Suyo")


if __name__ == "__main__":
    unittest.main()
