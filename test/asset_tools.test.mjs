import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import * as z from "zod/v4";
import {
  compactAssetDetailsForResponse,
  compactAssetSearchForResponse,
  registerUefnTools
} from "../src/lib/tools.mjs";

test("registers asset search/detail tools and asset search scope", () => {
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
  assert.ok(names.includes("uefn_asset_search"));
  assert.ok(names.includes("uefn_get_asset_details"));

  const search = registered.find((tool) => tool.name === "uefn_asset_search");
  z.object(search.metadata.inputSchema).parse({
    query: "BarProgress",
    types: ["Material", "MaterialInstance"],
    limit: 25
  });
  assert.throws(() => z.object(search.metadata.inputSchema).parse({ limit: 1000 }));

  const details = registered.find((tool) => tool.name === "uefn_get_asset_details");
  z.object(details.metadata.inputSchema).parse({
    asset: "/AirKings/Materials/BarProgress.BarProgress",
    matchBy: "path",
    includeDependencies: "both"
  });

  const searchAll = registered.find((tool) => tool.name === "uefn_search");
  z.object(searchAll.metadata.inputSchema).parse({ query: "HUD", scope: "assets" });
});

test("compacts asset search and details responses", () => {
  const assets = Array.from({ length: 35 }, (_, index) => ({
    name: `Asset_${index}`,
    class: index % 2 === 0 ? "Material" : "WidgetBlueprint",
    classPath: "/Script/Test.Asset",
    packagePath: "/AirKings/Materials",
    packageName: `/AirKings/Materials/Asset_${index}`,
    objectPath: `/AirKings/Materials/Asset_${index}.Asset_${index}`,
    loaded: false,
    redirector: false
  }));

  const compactSearch = compactAssetSearchForResponse({
    ok: true,
    assets,
    totalMatches: assets.length,
    typeCounts: [["Material", 18], ["WidgetBlueprint", 17]]
  }, "uefn://content/assets/id");

  assert.equal(compactSearch.assets.length, 30);
  assert.equal(compactSearch.omittedAssets, 5);
  assert.equal(compactSearch.resourceUri, "uefn://content/assets/id");

  const compactDetails = compactAssetDetailsForResponse({
    ok: true,
    asset: {
      ...assets[0],
      tags: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`Tag${index}`, index]))
    },
    properties: Array.from({ length: 28 }, (_, index) => ({
      name: `prop_${index}`,
      type: "str",
      value: `value_${index}`,
      writable: true,
      source: "asset_editor_property"
    })),
    dependencies: Array.from({ length: 22 }, (_, index) => `/AirKings/Dep_${index}`)
  }, "uefn://content/asset-details/id");

  assert.equal(compactDetails.tags.count, 25);
  assert.equal(compactDetails.tags.omittedTags, 5);
  assert.equal(compactDetails.properties.length, 25);
  assert.equal(compactDetails.omittedProperties, 3);
  assert.equal(compactDetails.dependencies.length, 20);
  assert.equal(compactDetails.omittedDependencies, 2);
});

test("python asset helpers normalize paths and serialize fake AssetData", () => {
  const pythonRoot = path.resolve(process.cwd(), "uefn-plugin", "Content", "Python");
  const script = `
import json
import sys
sys.path.insert(0, r"${pythonRoot.replaceAll("\\", "\\\\")}")
import uefn_mcp_bridge as b

class FakeTags(dict):
    pass

class FakeAssetData:
    asset_name = "BarProgress"
    package_name = "/AirKings/Materials/BarProgress"
    package_path = "/AirKings/Materials"
    asset_class_path = "/Script/Engine.Material"
    tags_and_values = FakeTags({"Parent": "/AirKings/Materials/Base"})

    def is_asset_loaded(self):
        return False

    def is_redirector(self):
        return False

    def to_soft_object_path(self):
        return "/AirKings/Materials/BarProgress.BarProgress"

    def get_tag_value(self, key):
        return {"GeneratedClass": "None"}.get(key)

payload = {
    "relative": b._normalize_asset_path("Materials/BarProgress", project_root="/AirKings"),
    "export": b._normalize_asset_path("Material'/AirKings/Materials/BarProgress.BarProgress'"),
    "asset": b._asset_data_to_dict(FakeAssetData(), include_tags=True, detail_level="summary"),
}
print(json.dumps(payload))
`;
  const result = spawnSync(process.env.PYTHON ?? "python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.relative, "/AirKings/Materials/BarProgress");
  assert.equal(payload.export, "/AirKings/Materials/BarProgress.BarProgress");
  assert.equal(payload.asset.name, "BarProgress");
  assert.equal(payload.asset.class, "Material");
  assert.equal(payload.asset.classPath, "/Script/Engine.Material");
  assert.equal(payload.asset.packageName, "/AirKings/Materials/BarProgress");
  assert.equal(payload.asset.objectPath, "/AirKings/Materials/BarProgress.BarProgress");
  assert.equal(payload.asset.tags.Parent, "/AirKings/Materials/Base");
});
