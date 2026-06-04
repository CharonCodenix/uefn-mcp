import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import * as z from "zod/v4";
import {
  compactActorDetailsForResponse,
  compactActorUpdateForResponse,
  registerUefnTools
} from "../src/lib/tools.mjs";

test("registers actor details/update tools and removes deprecated apply tool", () => {
  const registered = [];
  const server = {
    registerTool(name, metadata, handler) {
      registered.push({ name, metadata, handler });
    }
  };
  const store = {
    addJson() {
      return "uefn://test/resource";
    }
  };

  registerUefnTools(server, {}, store);
  const names = registered.map((tool) => tool.name);

  assert.ok(names.includes("uefn_get_actor_details"));
  assert.ok(names.includes("uefn_update_actor"));
  assert.equal(names.includes("uefn_apply_actor_changes"), false);

  const details = registered.find((tool) => tool.name === "uefn_get_actor_details");
  z.object(details.metadata.inputSchema).parse({ actor: "Seed_NitroHoop", matchBy: "label" });

  const update = registered.find((tool) => tool.name === "uefn_update_actor");
  z.object(update.metadata.inputSchema).parse({
    actor: "Seed_NitroHoop",
    operations: [{ path: "transform.location.z", op: "add", value: 350 }]
  });
  assert.throws(() => z.object(update.metadata.inputSchema).parse({
    actor: "Seed_NitroHoop",
    operations: [{ path: "transform.location.z", op: "multiply", value: 2 }]
  }));
});

test("compacts actor details and update responses", () => {
  const details = compactActorDetailsForResponse({
    ok: true,
    actor: {
      name: "Device_NitroHoop_C_01",
      label: "Seed_NitroHoop",
      class: "Device_NitroHoop_C",
      folder: null,
      path: "/Game/Seed_NitroHoop"
    },
    transform: { location: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1], writable: true },
    properties: Array.from({ length: 25 }, (_, index) => ({
      name: `prop_${index}`,
      type: "float",
      value: index,
      writable: true,
      source: "editor_property"
    })),
    components: [{
      name: "Root",
      class: "SceneComponent",
      path: "/Game/Root",
      writable: true,
      properties: Array.from({ length: 9 }, (_, index) => ({
        name: `component_prop_${index}`,
        type: "float",
        value: index,
        writable: true,
        source: "component_editor_property"
      }))
    }]
  }, "uefn://scene/actor-details/id");

  assert.equal(details.properties.length, 20);
  assert.equal(details.omittedProperties, 5);
  assert.equal(details.components[0].properties.length, 8);
  assert.equal(details.components[0].omittedProperties, 1);

  const update = compactActorUpdateForResponse({
    ok: false,
    dryRun: true,
    changes: [{ index: 0, path: "transform.location.z", op: "add", before: 394, after: 744, setter: "actor.set_actor_location", writable: true }],
    componentCandidates: [{ name: "Root", class: "SceneComponent", path: "/Game/Root", writable: true }]
  }, "uefn://scene/actor-updates/id");

  assert.equal(update.changes[0].setter, "actor.set_actor_location");
  assert.equal(update.componentCandidates[0].name, "Root");
});

test("python actor path parser rejects ActorLocation and plans transform setter", () => {
  const pythonRoot = path.resolve(process.cwd(), "uefn-plugin", "Content", "Python");
  const script = `
import json
import sys
sys.path.insert(0, r"${pythonRoot.replaceAll("\\", "\\\\")}")
import uefn_mcp_bridge as b

class Vector:
    def __init__(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z

class Rotator:
    roll = 0
    pitch = 90
    yaw = 0

class Actor:
    def get_actor_location(self):
        return Vector(-9689, -3093, 394)
    def get_actor_rotation(self):
        return Rotator()
    def get_actor_scale3d(self):
        return Vector(0.406, 0.406, 0.406)
    def set_actor_location(self, *args, **kwargs):
        pass
    def set_actor_rotation(self, *args, **kwargs):
        pass
    def set_actor_scale3d(self, *args, **kwargs):
        pass

parsed = b._parse_actor_update_path("transform.location.z")
change, _ = b._plan_transform_operation(Actor(), parsed, "add", 350, 0)
try:
    b._parse_actor_update_path("properties.ActorLocation")
except Exception as exc:
    rejected = str(exc)
else:
    rejected = None
print(json.dumps({"change": change, "rejected": rejected}))
`;
  const result = spawnSync(process.env.PYTHON ?? "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.change.setter, "actor.set_actor_location");
  assert.equal(payload.change.before, 394);
  assert.equal(payload.change.after, 744);
  assert.match(payload.rejected, /transform\.location/);
});
