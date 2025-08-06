import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { useLoadScript, GoogleMap, Marker } from "@react-google-maps/api";
import "./App.css";

// --- 유틸리티 & 상수 (컴포넌트 외부로 분리) ---

const KMA_API_BASE_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";
const GOOGLE_API_BASE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const AIR_KOREA_API_BASE_URL =
  "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty";

// 서울의 기본 위치 정보 상수
const DEFAULT_LOCATION = {
  lat: 37.5665,
  lng: 126.978,
  nx: 60,
  ny: 127,
  cityName: "서울특별시",
  countryName: "대한민국",
};

// 기상청 API 응답 코드 매핑
const SKY_MAP = {
  1: "sunny",
  3: "mostly_cloudy",
  4: "cloudy",
};

const PRECIP_MAP = {
  0: "sunny",
  1: "rainy",
  2: "rainy&snowy",
  3: "snowy",
  5: "rainy",
  6: "rainy&snowy",
  7: "snowy",
};

// 위경도 -> 기상청 격자 좌표 변환 함수
function convertToGrid(lat, lon) {
  const RE = 6371.00877,
    GRID = 5.0,
    SLAT1 = 30.0,
    SLAT2 = 60.0;
  const OLON = 126.0,
    OLAT = 38.0,
    XO = 43,
    YO = 136;
  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID,
    slat1 = SLAT1 * DEGRAD,
    slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD,
    olat = OLAT * DEGRAD;

  let sn =
    Math.tan(Math.PI * 0.25 + slat2 * 0.5) /
    Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

function getNowTime() {
  const now = new Date();
  const format = (num) => num.toString().padStart(2, "0");
  return `${now.getFullYear()}/${format(now.getMonth() + 1)}/${format(
    now.getDate()
  )} ${format(now.getHours())}:${format(now.getMinutes())}`;
}

function getWeekday(isoDate) {
  return new Date(isoDate).toLocaleDateString("ko-KR", { weekday: "short" });
}

// 커스텀 훅: 테마 관리
const useTheme = () => {
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem("theme") === "dark"
  );

  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("theme", next ? "dark" : "light");
      return next;
    });
  };

  return { isDark, toggleTheme };
};

const getGradeInfo = (grade) => {
  switch (grade) {
    case "1":
      return { text: "좋음", color: "#32a852" };
    case "2":
      return { text: "보통", color: "#3282a8" };
    case "3":
      return { text: "나쁨", color: "#ff8c00" };
    case "4":
      return { text: "매우 나쁨", color: "#d14023" };
    default:
      return { text: "알 수 없음", color: "#808080" };
  }
};

// ADDED: '서울특별시' -> '서울', '전라북도' -> '전북' 등으로 변환하는 함수
const formatSidoName = (sido) => {
  if (!sido) return "서울"; // 기본값

  const shortSido = {
    서울특별시: "서울",
    부산광역시: "부산",
    대구광역시: "대구",
    인천광역시: "인천",
    광주광역시: "광주",
    대전광역시: "대전",
    울산광역시: "울산",
    세종특별자치시: "세종",
    경기도: "경기",
    강원특별자치도: "강원",
    충청북도: "충북",
    충청남도: "충남",
    전북특별자치도: "전북",
    전라남도: "전남",
    경상북도: "경북",
    경상남도: "경남",
    제주특별자치도: "제주",
  };

  return shortSido[sido] || sido;
};

// --- 메인 컴포넌트 ---

export default function WeatherApp() {
  const { isDark, toggleTheme } = useTheme();
  const [spinning, setSpinning] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(getNowTime());

  // 위치 및 날씨 관련 상태
  const [nx, setNx] = useState(DEFAULT_LOCATION.nx);
  const [ny, setNy] = useState(DEFAULT_LOCATION.ny);
  const [mapCenter, setMapCenter] = useState({
    lat: DEFAULT_LOCATION.lat,
    lng: DEFAULT_LOCATION.lng,
  });
  const [cityName, setCityName] = useState(DEFAULT_LOCATION.cityName);
  const [countryName, setCountryName] = useState(DEFAULT_LOCATION.countryName);
  const [searchCity, setSearchCity] = useState("");

  const [weatherCurrent, setWeatherCurrent] = useState({
    temp: "--",
    humidity: "--",
    precipType: "",
  });
  const [weatherHourly, setWeatherHourly] = useState([]);
  const [weatherDaily, setWeatherDaily] = useState([]);

  const [airQuality, setAirQuality] = useState(null);

  const serviceKey = import.meta.env.VITE_KMA_KEY;
  const googleApiKey = import.meta.env.VITE_GOOGLE_API_KEY;
  const airKoreaKey = import.meta.env.VITE_AIR_KOREA_KEY;

  const { isLoaded, loadError } = useLoadScript({
    googleMapsApiKey: googleApiKey,
  });

  const fetchKmaData = useCallback(async () => {
    const now = new Date();
    now.setHours(now.getHours() - 1);
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const hh = now.getHours().toString().padStart(2, "0");
    const baseDate = yyyy + mm + dd;
    const baseTime = hh + "00";

    const commonParams = {
      serviceKey,
      pageNo: 1,
      dataType: "JSON",
      nx,
      ny,
    };

    try {
      // 4개 API를 병렬로 동시 요청하여 성능 개선
      const [ncstRes, fcstRes, vilaRes, airRes] = await Promise.all([
        // 1) 초단기실황
        axios.get(`${KMA_API_BASE_URL}/getUltraSrtNcst`, {
          params: {
            ...commonParams,
            base_date: baseDate,
            base_time: baseTime,
            numOfRows: 100,
          },
        }),
        // 2) 초단기예보
        axios.get(`${KMA_API_BASE_URL}/getUltraSrtFcst`, {
          params: {
            ...commonParams,
            base_date: baseDate,
            base_time: baseTime,
            numOfRows: 100,
          },
        }),
        // 3) 단기예보
        axios.get(`${KMA_API_BASE_URL}/getVilageFcst`, {
          params: {
            ...commonParams,
            base_date: baseDate,
            base_time: "0200",
            numOfRows: 1000,
          },
        }),
        // 4) 대기질 정보
        axios.get(AIR_KOREA_API_BASE_URL, {
          params: {
            serviceKey: airKoreaKey,
            returnType: "json",
            numOfRows: 100,
            pageNo: 1,
            sidoName:
              // "서울",
              formatSidoName(cityName.split(", ")[1] || cityName), // '전주시, 전라북도' -> '전북'
            ver: 1.5,
          },
        }),
      ]);

      // 1) 현재 날씨 처리
      const itemsNcst = ncstRes.data.response?.body?.items?.item ?? [];
      const current = {};
      itemsNcst.forEach((it) => {
        if (it.category === "T1H") current.temp = it.obsrValue;
        if (it.category === "REH") current.humidity = it.obsrValue;
        if (it.category === "PTY")
          current.precipType = PRECIP_MAP[it.obsrValue] || "-";
      });
      setWeatherCurrent(current);

      // 2) 시간별 예보 처리
      const itemsFcst = fcstRes.data.response?.body?.items?.item ?? [];
      const hourlyMap = itemsFcst.reduce((acc, it) => {
        const key = it.fcstTime;
        if (!acc[key]) acc[key] = { time: key };
        if (it.category === "T1H") acc[key].temp = it.fcstValue;
        if (it.category === "SKY") acc[key].sky = SKY_MAP[it.fcstValue];
        return acc;
      }, {});

      const currentHour = new Date().getHours();
      const nextHours = Array.from(
        { length: 6 },
        (_, i) => (currentHour + i) % 24
      ).map((h) => h.toString().padStart(2, "0") + "00");
      setWeatherHourly(
        nextHours.map((timeKey) => hourlyMap[timeKey]).filter(Boolean)
      );

      // 3) 3일 예보 처리
      const itemsVila = vilaRes.data.response?.body?.items?.item ?? [];
      const dailyMap = itemsVila.reduce((acc, it) => {
        const date = it.fcstDate;
        if (!acc[date]) acc[date] = { date };
        if (it.category === "TMX") acc[date].max = it.fcstValue;
        if (it.category === "TMN") acc[date].min = it.fcstValue;
        if (it.category === "POP") acc[date].pop = it.fcstValue;
        if (it.category === "SKY") acc[date].sky = SKY_MAP[it.fcstValue];
        return acc;
      }, {});

      console.log(JSON.stringify(airRes.data, null, 2));
      setWeatherDaily(Object.values(dailyMap).slice(1, 4));

      // 4) 대기질 정보 처리
      const airItems = airRes.data.response?.body?.items || [];
      const stationName = cityName.split(", ")[0]; // '전주시'
      // 현재 도시의 측정소 데이터 우선 검색, 없으면 해당 시/도 첫번째 데이터 사용
      const airData =
        airItems.find((item) => item.stationName === stationName) ||
        airItems[0];

      if (airData) {
        setAirQuality({
          station: airData.stationName,
          pm10Value: airData.pm10Value,
          pm10Grade: airData.pm10Grade,
          pm25Value: airData.pm25Value,
          pm25Grade: airData.pm25Grade,
          dataTime: airData.dataTime,
        });
      } else {
        setAirQuality(null); // 데이터가 없을 경우
      }
    } catch (error) {
      console.error("데이터 조회 중 오류 발생:", error);
    }
  }, [nx, ny, serviceKey, airKoreaKey, cityName]);

  useEffect(() => {
    fetchKmaData();
  }, [fetchKmaData]);

  const updateLocationInfo = useCallback(
    async ({ lat, lng }) => {
      try {
        const geoResp = await axios.get(GOOGLE_API_BASE_URL, {
          params: { key: googleApiKey, latlng: `${lat},${lng}` },
        });
        const result = geoResp.data.results[0];
        if (!result) return;

        const { long_name: country } =
          result.address_components.find((c) => c.types.includes("country")) ||
          {};
        if (country !== "대한민국") {
          alert("대한민국 영역만 선택 가능합니다.");
          // 기본 위치(서울)로 복귀
          setMapCenter({
            lat: DEFAULT_LOCATION.lat,
            lng: DEFAULT_LOCATION.lng,
          });
          setNx(DEFAULT_LOCATION.nx);
          setNy(DEFAULT_LOCATION.ny);
          setCityName(DEFAULT_LOCATION.cityName);
          setCountryName(DEFAULT_LOCATION.countryName);
          return;
        }

        // 시/도(administrative_area_level_1) 정보를 추출합니다.
        const { long_name: province } =
          result.address_components.find((c) =>
            c.types.includes("administrative_area_level_1")
          ) || {};

        // 도시/구(locality) 정보를 추출합니다.
        const { long_name: city } =
          result.address_components.find((c) => c.types.includes("locality")) ||
          {};

        // 동/읍/면(sublocality_level_1) 정보를 추출합니다.
        const { long_name: dong } =
          result.address_components.find((c) =>
            c.types.includes("sublocality_level_1")
          ) || {};

        const { nx: newNx, ny: newNy } = convertToGrid(lat, lng);
        setMapCenter({ lat, lng });

        // cityName에 도시/구와 시/도 정보를 모두 포함시킵니다.
        const newCityName = city ? `${city}, ${province}` : province;
        setCityName(newCityName);
        setCountryName(country);
        setNx(newNx);
        setNy(newNy);
      } catch (err) {
        console.error("리버스 지오코딩 오류:", err);
      }
    },
    [googleApiKey]
  );

  const handleMapClick = (e) => {
    updateLocationInfo({ lat: e.latLng.lat(), lng: e.latLng.lng() });
  };

  const handleCitySearch = async (e) => {
    e.preventDefault();
    if (!searchCity) return;
    try {
      const geoResp = await axios.get(GOOGLE_API_BASE_URL, {
        params: { key: googleApiKey, address: searchCity },
      });
      const result = geoResp.data.results[0];
      if (!result) {
        alert("검색 결과가 없습니다.");
        return;
      }
      // 주소 검색 후 좌표 기반으로 정보 업데이트 로직 재사용
      updateLocationInfo(result.geometry.location);
    } catch (err) {
      console.error("위치 검색 오류:", err);
      alert("도시명을 정확히 입력했는지 확인해주세요.");
    }
  };

  const handleRefreshClick = async () => {
    setSpinning(true);
    await fetchKmaData();
    setLastUpdate(getNowTime());
    setTimeout(() => setSpinning(false), 1000);
  };

  const roundStringToInt = (str) => Math.round(parseFloat(str)).toString();

  // --- 렌더링 (JSX) ---

  return (
    <div className={`weather-container${isDark ? " dark" : ""}`}>
      {/* Sidebar */}
      <aside className={`sidebar${isDark ? " dark" : ""}`}>
        <p className={`title${isDark ? " dark" : ""}`}>위치</p>
        <form className="search-row" onSubmit={handleCitySearch}>
          <img src="/icons/search.png" alt="검색" className="search-icon" />
          <input
            className="city-input"
            type="text"
            placeholder="도시 검색 (ex. 서울)"
            value={searchCity}
            onChange={(e) => setSearchCity(e.target.value)}
          />
        </form>
        <div className="map-placeholder">
          {loadError && <p>지도 로드 실패: {loadError.message}</p>}
          {!isLoaded && !loadError && <p>지도 로딩 중…</p>}
          {isLoaded && (
            <GoogleMap
              mapContainerStyle={{ width: "100%", height: "100%" }}
              center={mapCenter}
              mapId="weather_map"
              zoom={11}
              options={{
                restriction: {
                  latLngBounds: {
                    north: 38.63,
                    south: 33.0,
                    west: 124.6,
                    east: 131.87,
                  },
                  strictBounds: true,
                },
                minZoom: 6,
              }}
              onClick={handleMapClick}
            >
              <Marker position={mapCenter} />
            </GoogleMap>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="toggle-container">
          <img
            src="/icons/light_mode.png"
            alt="라이트 모드"
            className="mode-icon"
          />
          <label className="switch">
            <input type="checkbox" checked={isDark} onChange={toggleTheme} />
            <span className="slider"></span>
          </label>
          <img
            src="/icons/dark_mode.png"
            alt="다크 모드"
            className="mode-icon"
          />
        </div>

        {weatherCurrent && (
          <section className="current-weather">
            <div className="main-title">
              <p className="city-name">{`${cityName}, ${countryName}`}</p>
              <p className="temp">{weatherCurrent.temp}°C</p>
              <p className="humid">습도: {weatherCurrent.humidity}%</p>
              <div className="refresh-time-row">
                <p className="refresh-time">마지막 업데이트: {lastUpdate}</p>
                <button
                  className={`refresh-button${spinning ? " spinning" : ""}`}
                  onClick={handleRefreshClick}
                >
                  <img
                    src="/icons/refresh.png"
                    alt="새로고침"
                    className="refresh-button"
                  />
                </button>
              </div>
            </div>
            <img
              src={`/weather/${weatherCurrent.precipType}.png`}
              alt="현재 날씨"
              className="current-weather-image"
            />
          </section>
        )}

        <section className={`hourly-forecast${isDark ? " dark" : ""}`}>
          <p className="title">시간별 예보</p>
          <div className="hourly-forecast-list">
            {weatherHourly.map((h) => (
              <div className="hourly-forecast-child" key={h.time}>
                <p style={{ fontSize: "2rem", fontWeight: "500" }}>
                  {h.time.slice(0, 2)}:{h.time.slice(2, 4)}
                </p>
                <img
                  src={`/weather/${h.sky}.png`}
                  alt={`${h.time.slice(0, 2)}시 날씨`}
                  className="hourly-forecast-image"
                />
                <p style={{ fontSize: "3rem", fontWeight: "600" }}>
                  {roundStringToInt(h.temp)}°C
                </p>
              </div>
            ))}
          </div>
        </section>

        <div className="bottom-row">
          <section className={`daily-forecast${isDark ? " dark" : ""}`}>
            <p className="title">3일 단기 예보</p>
            <div className="daily-forecast-list">
              {weatherDaily.map((d) => (
                <div className="daily-forecast-child" key={d.date}>
                  <p style={{ fontSize: "2rem", fontWeight: "500", flex: "1" }}>
                    {`${d.date.slice(4, 6)}/${d.date.slice(6, 8)} (${getWeekday(
                      `${d.date.slice(0, 4)}-${d.date.slice(
                        4,
                        6
                      )}-${d.date.slice(6, 8)}`
                    )})`}
                  </p>
                  <div style={{ flex: "1" }}>
                    <img
                      src={`/weather/${d.sky}.png`}
                      alt={`${d.date}일 날씨`}
                      className="daily-forecast-image"
                    />
                  </div>
                  <p style={{ fontSize: "2rem", fontWeight: "600" }}>
                    {roundStringToInt(d.max)}°C / {roundStringToInt(d.min)}°C
                  </p>
                  <p style={{ fontSize: "1.5rem", fontWeight: "400" }}>
                    강수 확률: {d.pop}%
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className={`air-condition${isDark ? " dark" : ""}`}>
            <p className="title">대기질 상태</p>
            {airQuality ? (
              <div className="air-quality-content">
                <div className="air-quality-item">
                  <span className="air-label">미세먼지 (PM10)</span>
                  <span
                    className="air-grade"
                    style={{ color: getGradeInfo(airQuality.pm10Grade).color }}
                  >
                    {getGradeInfo(airQuality.pm10Grade).text}
                  </span>
                  <span className="air-value">
                    {airQuality.pm10Value} µg/m³
                  </span>
                </div>
                <div className="air-quality-item">
                  <span className="air-label">초미세먼지 (PM2.5)</span>
                  <span
                    className="air-grade"
                    style={{ color: getGradeInfo(airQuality.pm25Grade).color }}
                  >
                    {getGradeInfo(airQuality.pm25Grade).text}
                  </span>
                  <span className="air-value">
                    {airQuality.pm25Value} µg/m³
                  </span>
                </div>
                <p className="air-update-time">
                  ({airQuality.station} 측정소, {airQuality.dataTime} 기준)
                </p>
              </div>
            ) : (
              <p style={{ fontSize: "2rem" }}>
                대기질 정보를 불러오는 중이거나, 현재 위치의 데이터를 제공하지
                않습니다.
              </p>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
