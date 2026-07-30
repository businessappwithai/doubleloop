/**
 * @generated SignedSource<<00566b8611d51e4d66abc6313ba325af>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type SearchPanelQuery$variables = {
  bundleId: string;
  first?: number | null | undefined;
  text?: string | null | undefined;
};
export type SearchPanelQuery$data = {
  readonly search: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly id: string;
        readonly path: string;
        readonly rank: number;
        readonly snippet: string;
        readonly title: string;
      };
    }>;
    readonly totalCount: number;
  };
};
export type SearchPanelQuery = {
  response: SearchPanelQuery$data;
  variables: SearchPanelQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "bundleId"
},
v1 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "first"
},
v2 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "text"
},
v3 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "bundleId",
        "variableName": "bundleId"
      },
      {
        "kind": "Variable",
        "name": "first",
        "variableName": "first"
      },
      {
        "kind": "Variable",
        "name": "text",
        "variableName": "text"
      }
    ],
    "concreteType": "SearchHitConnection",
    "kind": "LinkedField",
    "name": "search",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "SearchHitEdge",
        "kind": "LinkedField",
        "name": "edges",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "SearchHit",
            "kind": "LinkedField",
            "name": "node",
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
                "name": "path",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "rank",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "snippet",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "totalCount",
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [
      (v0/*:: as any*/),
      (v1/*:: as any*/),
      (v2/*:: as any*/)
    ],
    "kind": "Fragment",
    "metadata": null,
    "name": "SearchPanelQuery",
    "selections": (v3/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [
      (v0/*:: as any*/),
      (v2/*:: as any*/),
      (v1/*:: as any*/)
    ],
    "kind": "Operation",
    "name": "SearchPanelQuery",
    "selections": (v3/*:: as any*/)
  },
  "params": {
    "cacheID": "ac33db2d96caeb9658d036e1f8580d7d",
    "id": null,
    "metadata": {},
    "name": "SearchPanelQuery",
    "operationKind": "query",
    "text": "query SearchPanelQuery(\n  $bundleId: ID!\n  $text: String\n  $first: Int\n) {\n  search(bundleId: $bundleId, text: $text, first: $first) {\n    edges {\n      node {\n        id\n        title\n        path\n        rank\n        snippet\n      }\n    }\n    totalCount\n  }\n}\n"
  }
};
})();

(node as any).hash = "f3e4ccb13820b770b6e7507a2eaa9ce3";

export default node;
