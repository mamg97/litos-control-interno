"""Synthetic regression tests: M4 must honor explicit material aliases."""

import unittest

from sync import normalize_material, validate


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


    def test_unconfirmed_blanco_bc_fails_closed(self):
        self.assertEqual(normalize_material("BLANCO B/C"), "BLANCO B/C")
        self.assertEqual(normalize_material("Blanco B/BC"), "Mármol blanco macael")
        proposal = {
            "fechaFicha": "26/09/2026", "modelo": "Tapanicho",
            "material": "Mármol blanco macael",
            "ancho": 89, "alto": 76,
            "especificaciones": "CORTE: BLANCO B/C; REPISA: SUYA",
            "confianzaGlobal": 99,
            "confianzaCampos": {
                "fechaFicha": 99, "modelo": 99, "material": 99,
                "ancho": 99, "alto": 99,
            },
            "camposDudosos": [], "dudas": "",
        }
        result = validate(proposal)
        self.assertFalse(result["auto_eligible"])
        self.assertEqual(result["values"]["Material propuesto"], "BLANCO B/C")
        self.assertIn("Alias de material no confirmado", result["notes"])

    def test_confirmed_blanco_alias_still_eligible(self):
        proposal = {
            "fechaFicha": "26/09/2026", "modelo": "Tapanicho",
            "material": "Blanco A/AB", "ancho": 89, "alto": 76,
            "especificaciones": "CORTE: BLANCO A/AB",
            "confianzaGlobal": 99,
            "confianzaCampos": {
                "fechaFicha": 99, "modelo": 99, "material": 99,
                "ancho": 99, "alto": 99,
            },
            "camposDudosos": [], "dudas": "",
        }
        result = validate(proposal)
        self.assertTrue(result["auto_eligible"])
        self.assertEqual(result["values"]["Material propuesto"], "Mármol blanco macael")


if __name__ == "__main__":
    unittest.main()
