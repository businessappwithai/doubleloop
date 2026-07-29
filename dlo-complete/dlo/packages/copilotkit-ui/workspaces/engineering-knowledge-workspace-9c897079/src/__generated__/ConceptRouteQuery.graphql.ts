/**
 * @generated SignedSource<<a22e1c3a1af3d05c0e5d308f708b7181>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type ConceptRouteQuery$variables = {
  conceptId: string;
};
export type ConceptRouteQuery$data = {
  readonly conceptDocument: {
    readonly bodyMarkdown: string;
  } | null | undefined;
  readonly node: {
    readonly __typename: "Concept";
    readonly ancestors: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
    }>;
    readonly bundleId: string;
    readonly id: string;
    readonly path: string;
    readonly title: string;
    readonly updatedAt: any;
    readonly version: number;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  } | null | undefined;
};
export type ConceptRouteQuery = {
  response: ConceptRouteQuery$data;
  variables: ConceptRouteQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "conceptId"
  }
],
v1 = [
  {
    "kind": "Variable",
    "name": "id",
    "variableName": "conceptId"
  }
],
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "__typename",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "bundleId",
  "storageKey": null
},
v5 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "title",
  "storageKey": null
},
v6 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "path",
  "storageKey": null
},
v7 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "version",
  "storageKey": null
},
v8 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "updatedAt",
  "storageKey": null
},
v9 = {
  "kind": "ClientExtension",
  "selections": [
    {
      "alias": null,
      "args": null,
      "concreteType": "Concept",
      "kind": "LinkedField",
      "name": "ancestors",
      "plural": true,
      "selections": [
        (v3/*:: as any*/),
        (v5/*:: as any*/)
      ],
      "storageKey": null
    }
  ]
},
v10 = {
  "kind": "ClientExtension",
  "selections": [
    {
      "alias": null,
      "args": [
        {
          "kind": "Variable",
          "name": "conceptId",
          "variableName": "conceptId"
        }
      ],
      "concreteType": "ConceptDocument",
      "kind": "LinkedField",
      "name": "conceptDocument",
      "plural": false,
      "selections": [
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "bodyMarkdown",
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ]
};
return {
  "fragment": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "ConceptRouteQuery",
    "selections": [
      {
        "alias": null,
        "args": (v1/*:: as any*/),
        "concreteType": null,
        "kind": "LinkedField",
        "name": "node",
        "plural": false,
        "selections": [
          (v2/*:: as any*/),
          {
            "kind": "InlineFragment",
            "selections": [
              (v3/*:: as any*/),
              (v4/*:: as any*/),
              (v5/*:: as any*/),
              (v6/*:: as any*/),
              (v7/*:: as any*/),
              (v8/*:: as any*/),
              (v9/*:: as any*/)
            ],
            "type": "Concept",
            "abstractKey": null
          }
        ],
        "storageKey": null
      },
      (v10/*:: as any*/)
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "ConceptRouteQuery",
    "selections": [
      {
        "alias": null,
        "args": (v1/*:: as any*/),
        "concreteType": null,
        "kind": "LinkedField",
        "name": "node",
        "plural": false,
        "selections": [
          (v2/*:: as any*/),
          (v3/*:: as any*/),
          {
            "kind": "InlineFragment",
            "selections": [
              (v4/*:: as any*/),
              (v5/*:: as any*/),
              (v6/*:: as any*/),
              (v7/*:: as any*/),
              (v8/*:: as any*/),
              (v9/*:: as any*/)
            ],
            "type": "Concept",
            "abstractKey": null
          }
        ],
        "storageKey": null
      },
      (v10/*:: as any*/)
    ]
  },
  "params": {
    "cacheID": "a6555809de992dcfde30d5fb2b7b1f76",
    "id": null,
    "metadata": {},
    "name": "ConceptRouteQuery",
    "operationKind": "query",
    "text": "query ConceptRouteQuery(\n  $conceptId: ID!\n) {\n  node(id: $conceptId) {\n    __typename\n    ... on Concept {\n      id\n      bundleId\n      title\n      path\n      version\n      updatedAt\n    }\n    id\n  }\n}\n"
  }
};
})();

(node as any).hash = "c6dbbc937c08e812f2267116a19f9cbb";

export default node;
