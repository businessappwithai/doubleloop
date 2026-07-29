/**
 * @generated SignedSource<<1bf1a63eb11a5b8d6eabd324fed68d85>>
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
    "kind": "ClientExtension",
    "selections": [
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
    ]
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
    "cacheID": "b17467a49eab3704305e140eb566be29",
    "id": null,
    "metadata": {},
    "name": "ConceptRouteBundleQuery",
    "operationKind": "query",
    "text": null
  }
};
})();

(node as any).hash = "773d72d236695d76f2a13fe7c351493a";

export default node;
