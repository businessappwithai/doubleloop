/**
 * @generated SignedSource<<59f5d4beae5822d36b3e48742e818d9c>>
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
  readonly rootConcept: {
    readonly childCount: number;
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
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "title",
  "storageKey": null
},
v3 = [
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
          (v1/*:: as any*/),
          (v2/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "description",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": "rootConcept",
        "args": [
          {
            "kind": "Variable",
            "name": "bundleId",
            "variableName": "bundleId"
          },
          {
            "kind": "Literal",
            "name": "path",
            "value": "index"
          }
        ],
        "concreteType": "Concept",
        "kind": "LinkedField",
        "name": "conceptByPath",
        "plural": false,
        "selections": [
          (v1/*:: as any*/),
          (v2/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "childCount",
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
    "name": "BundleRouteQuery",
    "selections": (v3/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "BundleRouteQuery",
    "selections": (v3/*:: as any*/)
  },
  "params": {
    "cacheID": "139b4aa6a03a95ddb3543349bd597b9f",
    "id": null,
    "metadata": {},
    "name": "BundleRouteQuery",
    "operationKind": "query",
    "text": null
  }
};
})();

(node as any).hash = "0527917e71a2f35117fad523cbe32479";

export default node;
