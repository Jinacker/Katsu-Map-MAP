// 구버전 앱에는 설정 메시지가 없으므로 기본 핀을 그대로 유지한다.
(function (root) {
  const validImage = (url) => typeof url === 'string' && /^https:\/\/storage\.googleapis\.com\/katsu-map-images\/launch-banners\/events\/[a-zA-Z0-9_-]+\.(png|gif|svg)$/.test(url);
  const rating = { normal: '1', good: '2', best: '3', top5: '4' };
  const normalize = (value) => {
    if (value?.enabled !== true || !Array.isArray(value.restaurantIds) || value.restaurantIds.length > 200
      || !value.restaurantIds.every((id) => Number.isInteger(id) && id > 0) || !['same', 'byRating'].includes(value.pinMode)) return null;
    return { ...value, ids: new Set(value.restaurantIds) };
  };
  const resolve = (config, restaurant) => {
    if (!config?.ids.has(restaurant.id)) return null;
    const url = config.pinMode === 'same' ? config.pinImageUrl : config.ratingPinImages?.[rating[restaurant.recommendLevel]];
    return validImage(url) ? url : null;
  };
  root.KatsuEventPins = { normalize, resolve };
  if (typeof module !== 'undefined') module.exports = root.KatsuEventPins;
})(typeof window !== 'undefined' ? window : globalThis);
