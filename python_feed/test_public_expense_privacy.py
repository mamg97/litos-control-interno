"""Regression tests: M7 public expenses must not disclose natural-person names."""
import json
import unittest

from export import sanitize_public_payload


class PublicExpensePrivacyTests(unittest.TestCase):
    def test_expense_free_text_is_pseudonymized_without_losing_amounts(self):
        marker = "Persona Ejemplo Apellido"
        raw = {
            "generatedAt": "2026-10-28T00:00:00Z",
            "records": [{"id": "TEST", "model": "Pieza"}],
            "expenses": [{
                "month": "2026-10",
                "category": "Material",
                "amount": 125.5,
                "nature": "Factura real",
                "source": marker,
                "invoiceDate": "2026-10-27",
                "reference": "TEST-001",
                "emailEvidence": f"Documento {marker}.pdf",
                "folderUrl": "",
                "documentUrl": "",
            }],
            "movements": [{
                "year": 2026, "date": "2026-10-27", "type": "GASTO",
                "concept": "COMPRA MATERIAL", "debit": 125.5,
                "credit": None, "balance": 10,
            }],
        }
        result = sanitize_public_payload(raw)
        expense = result["expenses"][0]
        self.assertEqual(expense["amount"], 125.5)
        self.assertEqual(expense["invoiceDate"], "2026-10-27")
        self.assertEqual(expense["reference"], "TEST-001")
        self.assertEqual(result["movements"][0]["debit"], 125.5)
        self.assertEqual(result["records"][0]["id"], "TEST")
        self.assertEqual(expense["source"], "Proveedor/servicio (identidad reservada)")
        self.assertEqual(expense["emailEvidence"], "Evidencia documental privada")
        self.assertNotIn(marker, json.dumps(result, ensure_ascii=False))

    def test_empty_private_evidence_stays_empty(self):
        result = sanitize_public_payload({
            "records": [], "movements": [],
            "expenses": [{"source": "", "emailEvidence": None, "amount": 3}],
        })
        self.assertEqual(result["expenses"][0]["source"], "")
        self.assertIsNone(result["expenses"][0]["emailEvidence"])
        self.assertEqual(result["expenses"][0]["amount"], 3)


if __name__ == "__main__":
    unittest.main()
