import test from "node:test";
import assert from "node:assert/strict";
import { prioritizeActorsForContext } from "../src/lib/tools.mjs";

test("prioritizes gameplay devices over generic meshes for scene context samples", () => {
  const actors = [
    {
      name: "SM_FORT_Floors_Generic_BasicTile_C_01",
      label: "Cuadro_X_418",
      class: "SM_FORT_Floors_Generic_BasicTile_C",
      folder: "CuadrosX"
    },
    {
      name: "VerseDevice_C_01",
      label: "economy manager",
      class: "VerseDevice_C",
      folder: "CustomCreativeDevices"
    },
    {
      name: "FortStaticMeshActor_01",
      label: "test cube",
      class: "FortStaticMeshActor",
      folder: "Prototype"
    },
    {
      name: "Device_Trigger_V2_C_01",
      label: "ActivadorD_7_33",
      class: "Device_Trigger_V2_C",
      folder: "Carril7/Triggers"
    }
  ];

  const ranked = prioritizeActorsForContext(actors);

  assert.equal(ranked[0].label, "economy manager");
  assert.equal(ranked[1].label, "ActivadorD_7_33");
  assert.equal(ranked.at(-1).label, "test cube");
});

test("prioritizes selected actors before other important actors", () => {
  const actors = [
    {
      name: "VerseDevice_C_01",
      label: "economy manager",
      class: "VerseDevice_C",
      folder: "CustomCreativeDevices"
    },
    {
      name: "Device_Trigger_V2_C_01",
      label: "ActivadorD_7_33",
      class: "Device_Trigger_V2_C",
      folder: "Carril7/Triggers"
    }
  ];

  const ranked = prioritizeActorsForContext(actors, [{ label: "ActivadorD_7_33" }]);

  assert.equal(ranked[0].label, "ActivadorD_7_33");
});
