import assert from "node:assert/strict";
import test from "node:test";
import { buildUiPlan } from "../src/penpot-ui-plan.mjs";

const cases = [
  ["left","top",[20,10,60,40]],
  ["right","bottom",[120,60,60,40]],
  ["center","center",[70,35,60,40]],
  ["leftright","topbottom",[20,10,160,90]],
  ["scale","scale",[30,15,90,60]]
];
for (const [horizontal, vertical, expanded] of cases) {
  test(horizontal + "/" + vertical + " preserves the design and resizes correctly", () => {
    const root = { id:"r", name:"Card", type:"board", x:400, y:300, width:200, height:100, childIds:["child"] };
    const child = { id:"child", name:"Label", type:"text", parentId:"r", parentX:20, parentY:10, width:60, height:40, content:{characters:"领取"}, constraints:{horizontal,vertical} };
    const data = { file:{id:"f"}, pages:[{id:"p",shapes:[root,child]}] };
    const plan = buildUiPlan(data,"p","r","Assets/Card.prefab");
    assert.deepEqual(plan.target.referenceResolution,{width:200,height:100});
    const [node] = plan.nodes;
    assert.equal(node.kind,"text");
    assert.equal(node.text.value,"领取");
    const {anchorMin:a,anchorMax:b,pivot:p,anchoredPosition:pos,sizeDelta:d}=node.rect;
    function bounds(w,h) {
      const width=(b.x-a.x)*w+d.x, height=(b.y-a.y)*h+d.y;
      return [a.x*w+pos.x-p.x*d.x,h-b.y*h-pos.y-(1-p.y)*d.y,width,height].map(Math.round);
    }
    assert.deepEqual(bounds(200,100),[20,10,60,40]);
    assert.deepEqual(bounds(300,150),expanded);
  });
}
