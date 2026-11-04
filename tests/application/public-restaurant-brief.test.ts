import { expect, it } from "vitest";
import { publicRestaurantBrief } from "../../src/application/public-restaurant-brief.js";
const brief:any={version:1,retrievedAt:"2026-11-03T19:00:00Z",sources:[],address:{status:"unknown"},hours:{status:"unknown"},booking:{status:"unknown"},dietary:{status:"unknown"}};
const state:any={dinner:{constraints:{other:{dietary:[{requirement:"SECRET_HEALTH_CONDITION"}],travel:{origin:"SECRET_HOME_ORIGIN"}}}},roster:[{id:"12345678",name:"Private Attendee"}]};
it("withholds private health phrases, travel origin and participant attribution from public briefs",()=>{
  for(const secret of ["SECRET_HEALTH_CONDITION","SECRET_HOME_ORIGIN","Private Attendee","12345678"]){
    expect(publicRestaurantBrief({...brief,sourcedSummary:{text:`For ${secret}, try the menu.`,sourceUrls:["https://restaurant.example/menu"]}},state)).toBeUndefined();
  }
});
it("allows canonical public dietary categories and menu facts",()=>{
  expect(publicRestaurantBrief({...brief,dietary:{status:"partial",assessments:[{requirement:"vegetarian",assessment:"promising",dishes:["Mushroom okonomiyaki"]}]}},state)?.dietary.assessments[0]?.dishes).toEqual(["Mushroom okonomiyaki"]);
});
