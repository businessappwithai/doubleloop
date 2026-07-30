/**
 * @generated SignedSource<<3d9140944422a4cda57998a000e392df>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type BundleRouteQuery$variables = {
  bundleId: string;
};
export type BundleRouteQuery$data = {
  readonly bundle: {
    readonly description: string;
    readonly id: string;
    readonly title: string;
  } | null | undefined;
};
export type BundleRouteQuery = {
  response: BundleRouteQuery$data;
  variables: BundleRouteQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "bundleId"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "id",
        "variableName": "bundleId"
      }
    ],
    "concreteType": "Bundle",
    "kind": "LinkedField",
    "name": "bundle",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "id",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "title",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "description",
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "BundleRouteQuery",
    "selections": (v1/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "BundleRouteQuery",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "883eaf4e7db7ed9515118ade70378db0",
    "id": null,
    "metadata": {},
    "name": "BundleRouteQuery",
    "operationKind": "query",
    "text": "query BundleRouteQuery(\n  $bundleId: ID!\n) {\n  bundle(id: $bundleId) {\n    id\n    title\n    description\n  }\n}\n"
  }
};
})();

(node as any).hash = "c85e296e1cce952500638fd3bd4b6ed4";

export default node;
