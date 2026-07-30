const INVENTORY_BAG_LANE_NAMES = new Set(['slots', 'generatedEquipment']);

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ChainExpression'
    ) {
      current = current.expression;
      continue;
    }
    if (current.type === 'ParenthesizedExpression') {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return null;
}

function hasInventoryBagType(node) {
  if (!node) return false;
  switch (node.type) {
    case 'TSTypeAnnotation':
      return hasInventoryBagType(node.typeAnnotation);
    case 'TSTypeReference':
      return node.typeName.type === 'Identifier' && node.typeName.name === 'InventoryBag';
    case 'TSUnionType':
    case 'TSIntersectionType':
      return node.types.some(hasInventoryBagType);
    case 'TSParenthesizedType':
      return hasInventoryBagType(node.typeAnnotation);
    default:
      return false;
  }
}

function hasInventoryBagAnnotation(node) {
  if (!node) return false;
  if ('typeAnnotation' in node && node.typeAnnotation) {
    return hasInventoryBagType(node.typeAnnotation);
  }
  return false;
}

function findVariable(scope, name) {
  let current = scope;
  while (current) {
    const match = current.variables?.find((variable) => variable.name === name);
    if (match) {
      return match;
    }
    current = current.upper;
  }
  return null;
}

function isInventoryMapGetCall(node) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || unwrapped.type !== 'CallExpression') {
    return false;
  }
  const callee = unwrapExpression(unwrapped.callee);
  if (!callee || callee.type !== 'MemberExpression') {
    return false;
  }
  if (getPropertyName(callee.property) !== 'get') {
    return false;
  }
  const object = unwrapExpression(callee.object);
  return (
    object?.type === 'MemberExpression' && getPropertyName(object.property) === 'inventories'
  );
}

function resolvesIdentifierToInventoryBag(identifier, context, seen) {
  const scope = context.sourceCode.getScope(identifier);
  const variable = findVariable(scope, identifier.name);
  if (!variable) {
    return false;
  }
  if (variable.identifiers?.some(hasInventoryBagAnnotation)) {
    return true;
  }
  for (const def of variable.defs ?? []) {
    if (hasInventoryBagAnnotation(def.name)) {
      return true;
    }
    const definitionNode = def.node;
    if (!definitionNode) {
      continue;
    }
    if (definitionNode.type === 'VariableDeclarator') {
      if (hasInventoryBagAnnotation(definitionNode.id)) {
        return true;
      }
      if (definitionNode.init && resolvesToInventoryBag(definitionNode.init, context, seen)) {
        return true;
      }
      continue;
    }
    if (definitionNode.type === 'AssignmentPattern') {
      if (hasInventoryBagAnnotation(definitionNode.left)) {
        return true;
      }
      if (definitionNode.right && resolvesToInventoryBag(definitionNode.right, context, seen)) {
        return true;
      }
    }
  }
  for (const reference of variable.references ?? []) {
    if (!reference.isWrite?.() || !reference.writeExpr) {
      continue;
    }
    if (resolvesToInventoryBag(reference.writeExpr, context, seen)) {
      return true;
    }
  }
  return false;
}

function resolvesToInventoryBag(node, context, seen = new Set()) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);
  switch (unwrapped.type) {
    case 'Identifier':
      return resolvesIdentifierToInventoryBag(unwrapped, context, seen);
    case 'CallExpression':
      return isInventoryMapGetCall(unwrapped);
    case 'ConditionalExpression':
      return (
        resolvesToInventoryBag(unwrapped.consequent, context, seen) ||
        resolvesToInventoryBag(unwrapped.alternate, context, seen)
      );
    case 'LogicalExpression':
      return (
        resolvesToInventoryBag(unwrapped.left, context, seen) ||
        resolvesToInventoryBag(unwrapped.right, context, seen)
      );
    case 'SequenceExpression':
      return unwrapped.expressions.some((expression) =>
        resolvesToInventoryBag(expression, context, seen),
      );
    default:
      return false;
  }
}

const inventorybagLaneAccessRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct InventoryBag lane access outside the owner module so consumers use shared accessors.',
    },
    schema: [],
    messages: {
      slots:
        'Do not read InventoryBag.slots directly outside src/shared/inventory.ts. Use listInventoryEntries/listStaticInventorySlots or accessor helpers instead.',
      generated:
        'Do not read InventoryBag.generatedEquipment directly outside src/shared/inventory.ts. Use listInventoryEntries/listGeneratedEquipmentReferences instead.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const propertyName = getPropertyName(node.property);
        if (!INVENTORY_BAG_LANE_NAMES.has(propertyName)) {
          return;
        }
        if (!resolvesToInventoryBag(node.object, context)) {
          return;
        }
        context.report({
          node: node.property,
          messageId: propertyName === 'slots' ? 'slots' : 'generated',
        });
      },
    };
  },
};

export default inventorybagLaneAccessRule;
