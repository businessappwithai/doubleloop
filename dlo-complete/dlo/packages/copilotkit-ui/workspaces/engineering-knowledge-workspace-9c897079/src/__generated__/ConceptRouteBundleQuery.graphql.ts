/**
 * @generated SignedSource<<77568397cbd2fed42fab4c632cf722da>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type TrustLevel = "HUMAN_REVIEWED" | "MACHINE_CONFIRMED" | "UNVERIFIED" | "%future added value";
export type ConceptRouteBundleQuery$variables = {
  bundleId: string;
};
export type ConceptRouteBundleQuery$data = {
  readonly bundle: {
    readonly defaultTrust: TrustLevel;
    readonly id: string;
    readonly title: string;
  } | null | undefined;
};
export type ConceptRouteBundleQuery = {
  response: ConceptRouteBundleQuery$data;
  variables: ConceptRouteBundleQuery$variables;
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
        "name": "defaultTrust",
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
    "name": "ConceptRouteBundleQuery",
    "selections": (v1/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "ConceptRouteBundleQuery",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "51fcba95d7df4ea1dbeccf656e7267f2",
    "id": null,
    "metadata": {},
    "name": "ConceptRouteBundleQuery",
    "operationKind": "query",
    "text": "query ConceptRouteBundleQuery(\n  $bundleId: ID!\n) {\n  bundle(id: $bundleId) {\n    id\n    title\n    defaultTrust\n  }\n}\n"
  }
};
})();

(node as any).hash = "773d72d236695d76f2a13fe7c351493a";

export default node;
