from __future__ import annotations

from io import BytesIO
import unittest

import openpyxl

from source_item_guard import apply_explicit_absences, has_unrequested_rows


def workbook_bytes():
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    for idx, label in enumerate(
        ["CORONACIÓN", "COLUMNA / PILASTRA", "CRUZ", "FLORERO",
         "CORNISA", "TABICA / TACOS", "REPISA", "IMAGEN / FOTO"], start=1
    ):
        sheet.cell(idx, 1).value = label
        sheet.cell(idx, 5).value = 1
        sheet.cell(idx, 6).value = 25
        sheet.cell(idx, 7).value = f"=E{idx}*F{idx}"
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


class SourceAbsenceTests(unittest.TestCase):
    def test_removes_only_explicit_absences_and_preserves_present_items(self):
        source = {
            "Especificaciones": (
                "CORONACION: -. COLUMNAS: -. PILASTRAS: -. CRUZ: -. "
                "FLORERO: -. CORNISA: -. TABICA Y TACOS: -. "
                "REPISA: fijada. IMAGEN: presente. FOTO: -."
            )
        }
        original = workbook_bytes()
        changed, removed = apply_explicit_absences(original, source)
        self.assertEqual(
            set(removed),
            {"CORONACIÓN", "COLUMNA / PILASTRA", "CRUZ", "FLORERO",
             "CORNISA", "TABICA / TACOS"},
        )
        self.assertTrue(has_unrequested_rows(original, removed))
        self.assertFalse(has_unrequested_rows(changed, removed))
        workbook = openpyxl.load_workbook(BytesIO(changed))
        try:
            sheet = workbook.active
            for row_idx in range(1, 7):
                self.assertTrue(all(sheet.cell(row_idx, col).value is None for col in range(1, 8)))
            self.assertEqual(sheet.cell(7, 1).value, "REPISA")
            self.assertEqual(sheet.cell(7, 5).value, 1)
            self.assertEqual(sheet.cell(8, 1).value, "IMAGEN / FOTO")
        finally:
            workbook.close()

    def test_explicit_absence_with_merged_detail_cells(self):
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet["A4"] = "FLORERO"
        sheet["B4"] = "Synthetic optional item"
        sheet["E4"] = 1
        sheet["F4"] = 25
        sheet["G4"] = "=E4*F4"
        sheet.merge_cells("B4:D4")
        before = BytesIO()
        workbook.save(before)
        workbook.close()

        changed, removed = apply_explicit_absences(
            before.getvalue(), {"Especificaciones": "FLORERO: -."}
        )
        self.assertEqual(removed, ["FLORERO"])
        verified = openpyxl.load_workbook(BytesIO(changed))
        try:
            ws = verified.active
            self.assertIn("B4:D4", {str(x) for x in ws.merged_cells.ranges})
            self.assertTrue(all(ws.cell(4, col).value is None for col in range(1, 8)))
        finally:
            verified.close()

    def test_missing_or_conflicting_absence_is_not_inferred(self):
        original = workbook_bytes()
        for specs in [
            "",
            "CRUZ: -; CRUZ: grabada.",
            "COLUMNAS: -. PILASTRAS: grabadas.",
            "FLORERO: 2 unidades.",
        ]:
            changed, removed = apply_explicit_absences(original, {"Especificaciones": specs})
            self.assertEqual(removed, [])
            self.assertEqual(changed, original)

    def test_explicit_quantity_is_not_erased(self):
        from runner import _apply_declared_item_quantities
        original = workbook_bytes()
        for specifications in ["FLORERO: 2 unidades.", "FLORERO: 2 floreros de referencia."]:
            changed, corrections = _apply_declared_item_quantities(
                original, {"Especificaciones": specifications}
            )
            self.assertEqual(len(corrections), 1)
            workbook = openpyxl.load_workbook(BytesIO(changed))
            try:
                self.assertEqual(workbook.active.cell(4, 5).value, 2)
            finally:
                workbook.close()


if __name__ == "__main__":
    unittest.main()
